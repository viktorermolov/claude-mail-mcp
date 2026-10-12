/**
 * Turns a parsed message into compact, readable plain text.
 *
 * Newsletters often ship a text/plain part that is really leftover HTML
 * (Outlook/MSO conditional comments, table markup, &nbsp; runs). We use
 * the text/plain part when it looks like real text and otherwise convert
 * the HTML part with html-to-text: no images, no styles, links kept as
 * "label <url>" (or just the URL when it equals the label).
 */

import { convert, type HtmlToTextOptions } from "html-to-text";

const HTML_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  preserveNewlines: false,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "head", format: "skip" },
    // Hidden preheaders and tracking blocks.
    { selector: "[style*='display:none']", format: "skip" },
    { selector: "[style*='display: none']", format: "skip" },
    { selector: "[hidden]", format: "skip" },
    // Mail layouts nest tables for positioning; read them as plain blocks
    // instead of ASCII tables.
    { selector: "table", format: "block" },
    { selector: "tr", format: "block" },
    { selector: "td", format: "block" },
    { selector: "th", format: "block" },
    {
      selector: "a",
      options: {
        hideLinkHrefIfSameAsText: true,
        linkBrackets: ["<", ">"],
        ignoreHref: false,
        noAnchorUrl: true,
      },
    },
    { selector: "h1", options: { uppercase: false } },
    { selector: "h2", options: { uppercase: false } },
    { selector: "h3", options: { uppercase: false } },
    { selector: "h4", options: { uppercase: false } },
    { selector: "h5", options: { uppercase: false } },
    { selector: "h6", options: { uppercase: false } },
    { selector: "th", options: { uppercase: false } },
    { selector: "hr", format: "skip" },
  ],
};

/** Heuristic: does a text/plain part actually contain HTML/MSO leftovers? */
export function looksLikeHtmlJunk(text: string): boolean {
  const sample = text.slice(0, 50_000);
  if (/<!--\[if\s/i.test(sample) || /<!\[endif\]-->/i.test(sample)) return true;
  if (/<\/?(table|tbody|tr|td|div|span|font|center|v:[a-z]+)\b/i.test(sample)) return true;
  const tags = sample.match(/<\/?[a-z][a-z0-9:-]*(\s[^<>]*)?>/gi)?.length ?? 0;
  const entities = sample.match(/&(nbsp|zwnj|#8203|#160|#847);/gi)?.length ?? 0;
  return tags > 10 || entities > 20;
}

export function htmlToPlain(html: string): string {
  return tidy(convert(html, HTML_OPTIONS));
}

/**
 * Collapse invisible characters and blank-line runs that newsletters use
 * for spacing; keep paragraph breaks.
 */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    // zero-width and soft-hyphen padding (preheader filler)
    .replace(/[​-‍⁠﻿­͏]/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type BodySource = "text" | "html" | "none";

/** Pick the best readable text for a message. */
export function readableBody(parsed: {
  text?: string | null;
  html?: string | false | null;
}): { text: string; source: BodySource } {
  const plain = typeof parsed.text === "string" ? parsed.text : "";
  const html = typeof parsed.html === "string" ? parsed.html : "";
  if (plain.trim() && !looksLikeHtmlJunk(plain)) {
    return { text: tidy(plain), source: "text" };
  }
  if (html.trim()) {
    return { text: htmlToPlain(html), source: "html" };
  }
  if (plain.trim()) {
    // Junky text/plain and no HTML part: strip what we can.
    return { text: cleanJunkPlain(plain), source: "text" };
  }
  return { text: "", source: "none" };
}

/**
 * Best effort for a text/plain part full of HTML/MSO leftovers when there
 * is no HTML part to fall back to: drop tags and comments, then the
 * Markdown-style image and table residue some generators emit.
 */
export function cleanJunkPlain(text: string): string {
  return tidy(
    htmlToPlain(text)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/^[ \t|]+$/gm, "")
      .replace(/^\s*\|\s?|\s?\|\s*$/gm, "")
      .replace(/^#{1,6}\s+/gm, "")
  );
}

/** A one-line preview of at most `max` characters. */
export function previewOf(text: string, max = 200): string | null {
  const one = text
    .replace(/[-=_*~#]{4,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!one) return null;
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}

export interface TextWindow {
  text: string;
  offset: number;
  total_length: number;
  truncated: boolean;
  next_offset: number | null;
}

/**
 * Return `max` characters starting at `offset`. When the window ends mid
 * text, it is pulled back to the last line break or space within the final
 * 10% so words aren't cut; next_offset continues exactly where it stopped.
 */
export function windowText(full: string, offset: number, max: number): TextWindow {
  const total = full.length;
  const start = Math.min(Math.max(0, offset), total);
  let end = Math.min(start + max, total);
  if (end < total) {
    const slice = full.slice(start, end);
    const floor = Math.floor(slice.length * 0.9);
    const nl = slice.lastIndexOf("\n");
    const sp = slice.lastIndexOf(" ");
    const cut = nl >= floor ? nl : sp >= floor ? sp : -1;
    if (cut > 0) end = start + cut + 1;
  }
  return {
    text: full.slice(start, end),
    offset: start,
    total_length: total,
    truncated: end < total,
    next_offset: end < total ? end : null,
  };
}

/**
 * Replace inline "label <url>" links with numbered references "label [n]"
 * and return the URLs separately. Tracking URLs can be hundreds of
 * characters and can't be shortened without breaking them; moving them
 * out of the prose keeps the text readable and lets callers skip them.
 * Repeated URLs share one number.
 */
export function footnoteLinks(text: string): { text: string; links: string[] } {
  const links: string[] = [];
  const index = new Map<string, number>();
  const out = text.replace(/\s?<((?:https?|mailto):[^\s<>]+)>/gi, (_m, url: string) => {
    let n = index.get(url);
    if (n === undefined) {
      links.push(url);
      n = links.length;
      index.set(url, n);
    }
    return ` [${n}]`;
  });
  return { text: out, links };
}

/** Links referenced as [n] inside a piece of text, keyed by number. */
export function linksIn(text: string, links: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= links.length) out[n] = links[n - 1];
  }
  return out;
}

/** Text for one-line previews: no URLs, no reference markers. */
export function stripLinks(text: string): string {
  return text
    .replace(/\s?<(?:https?|mailto):[^\s<>]+>/gi, "")
    .replace(/\s?\[\d+\]/g, "")
    .replace(/\bhttps?:\/\/\S+/gi, "");
}
