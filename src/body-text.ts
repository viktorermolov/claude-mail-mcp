/**
 * Turns a parsed message into compact, readable plain text.
 *
 * Newsletters often ship a text/plain part that is really leftover HTML
 * (Outlook/MSO conditional comments, table markup, &nbsp; runs). We use
 * the text/plain part when it looks like real text and otherwise convert
 * the HTML part with html-to-text: no images, no styles, links kept as
 * "label <url>" (or just the URL when it equals the label) and later
 * turned into numbered references by footnoteLinks().
 *
 * Everything here runs on attacker-controlled input (any sender can mail
 * the account), so every regex is linear-time and input sizes are capped.
 */

import { convert, type HtmlToTextOptions } from "html-to-text";

/** Input caps: beyond these the remainder is dropped (and reported via total_length). */
export const MAX_PLAIN_CHARS = 2_000_000;
export const MAX_HTML_CHARS = 4_000_000;

const HTML_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  preserveNewlines: false,
  // Deeply nested (often unclosed) tags would otherwise overflow the stack.
  limits: { maxDepth: 500, maxInputLength: MAX_HTML_CHARS },
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "head", format: "skip" },
    // Hidden preheaders and tracking blocks. Best effort only — this is a
    // compaction feature, not a security boundary against hidden text.
    { selector: "[style*='display:none']", format: "skip" },
    { selector: "[style*='display: none']", format: "skip" },
    { selector: "[style*='DISPLAY:NONE']", format: "skip" },
    { selector: "[style*='mso-hide:all']", format: "skip" },
    { selector: "[style*='visibility:hidden']", format: "skip" },
    { selector: "[hidden]", format: "skip" },
    // Mail layouts nest tables for positioning; read them as plain blocks
    // instead of ASCII tables.
    { selector: "table", format: "block" },
    { selector: "tr", format: "block" },
    { selector: "td", format: "block" },
    { selector: "th", format: "block", options: { uppercase: false } },
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
  return tidy(convert(html.slice(0, MAX_HTML_CHARS), HTML_OPTIONS));
}

/**
 * Space-like characters newsletters use for layout: every Unicode space
 * separator plus the "blank" letters (Hangul fillers, braille blank) that
 * render as empty space.
 */
const SPACE_LIKE = /[\p{Zs}\u2800\u3164\u115f\u1160\uffa0\u180e]/gu;
/** Invisible padding: zero-width characters, soft hyphen, combining grapheme joiner, word joiner, BOM. */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad\u034f]/g;

/**
 * Collapse invisible characters and blank-line runs that newsletters use
 * for spacing; keep paragraph breaks. Linear time: horizontal whitespace
 * runs are collapsed first, so the line-edge trims never backtrack.
 */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(SPACE_LIKE, " ")
    .replace(INVISIBLE, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ \n/g, "\n")
    .replace(/\n /g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type BodySource = "text" | "html" | "none";

/** Pick the best readable text for a message. */
export function readableBody(parsed: {
  text?: string | null;
  html?: string | false | null;
}): { text: string; source: BodySource } {
  const plain = typeof parsed.text === "string" ? parsed.text.slice(0, MAX_PLAIN_CHARS) : "";
  const html = typeof parsed.html === "string" ? parsed.html.slice(0, MAX_HTML_CHARS) : "";
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
 * (Character classes exclude the opening delimiter so these stay linear.)
 */
export function cleanJunkPlain(text: string): string {
  return tidy(
    htmlToPlain(text)
      .replace(/!\[[^\][]*\]\([^)(]*\)/g, "")
      .replace(/^[ \t|]+$/gm, "")
      .replace(/^[ \t]*\|[ \t]?|[ \t]?\|[ \t]*$/gm, "")
      .replace(/^#{1,6}[ \t]+/gm, "")
  );
}

/** A one-line preview of at most `max` characters (never splits a surrogate pair). */
export function previewOf(text: string, max = 200): string | null {
  const one = text
    .replace(/[-=_*~#]{4,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!one) return null;
  if (one.length <= max) return one;
  let cut = max - 1;
  if (isHighSurrogate(one.charCodeAt(cut - 1))) cut--;
  return one.slice(0, cut).trimEnd() + "…";
}

export interface TextWindow {
  text: string;
  offset: number;
  total_length: number;
  truncated: boolean;
  next_offset: number | null;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * Return about `max` characters starting at `offset`. When the window ends
 * mid text, it is pulled back to the last line break or space within the
 * final 10% so words aren't cut, never ends inside a "[12]" reference or a
 * surrogate pair, and next_offset continues exactly where it stopped.
 */
export function windowText(full: string, offset: number, max: number): TextWindow {
  const total = full.length;
  let start = Math.min(Math.max(0, offset), total);
  if (start > 0 && start < total && isLowSurrogate(full.charCodeAt(start)) && isHighSurrogate(full.charCodeAt(start - 1))) {
    start--;
  }
  let end = Math.min(start + max, total);
  if (end < total) {
    const slice = full.slice(start, end);
    const floor = Math.floor(slice.length * 0.9);
    const nl = slice.lastIndexOf("\n");
    const sp = slice.lastIndexOf(" ");
    const cut = nl >= floor ? nl : sp >= floor ? sp : -1;
    if (cut > 0) {
      end = start + cut + 1;
    } else {
      // Hard cut: don't split a reference marker or a surrogate pair.
      const marker = /\[\d*$/.exec(slice);
      if (marker && marker.index > 0) end = start + marker.index;
      if (end > start + 1 && isHighSurrogate(full.charCodeAt(end - 1))) end--;
    }
  }
  return {
    text: full.slice(start, end),
    offset: start,
    total_length: total,
    truncated: end < total,
    next_offset: end < total ? end : null,
  };
}

/** Bare URLs at least this long are replaced by a reference too. */
export const LONG_URL_CHARS = 100;

/**
 * Replace links with numbered references and return the URLs separately:
 *   - "label <url>" (html-to-text output, also common in text/plain) → "label [n]";
 *   - bare URLs of LONG_URL_CHARS or more (tracking links, image links whose
 *     label was an image) → "[n]".
 * Short bare URLs stay inline. Repeated URLs share one number. Bracketed
 * numbers already present in the mail ("[1]") are rewritten to "(1)" first
 * so they can't be confused with our references.
 */
export function footnoteLinks(text: string): { text: string; links: string[] } {
  const links: string[] = [];
  const index = new Map<string, number>();
  const ref = (url: string): number => {
    let n = index.get(url);
    if (n === undefined) {
      links.push(url);
      n = links.length;
      index.set(url, n);
    }
    return n;
  };
  // One pass over both forms so numbers follow reading order.
  const out = text
    .replace(/\[(\d{1,6})\]/g, "($1)")
    .replace(/\s?<((?:https?|mailto):[^\s<>]+)>|\bhttps?:\/\/[^\s<>"']+/gi, (match: string, bracketed?: string) => {
      if (bracketed) return ` [${ref(bracketed)}]`;
      // Trailing sentence punctuation is not part of the URL (a loop, not
      // a regex, so a run of ')' can't cause backtracking).
      let end = match.length;
      while (end > 0 && ".,;:!?)]".includes(match[end - 1])) end--;
      const clean = match.slice(0, end);
      return clean.length >= LONG_URL_CHARS ? `[${ref(clean)}]${match.slice(end)}` : match;
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
