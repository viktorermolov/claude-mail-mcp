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
 * The HTML parser (htmlparser2) is quadratic in nesting depth and builds a
 * full DOM, so HTML with more than MAX_HTML_TAGS tags is not parsed at all:
 * a linear scanner strips its markup instead.
 */

import { convert, type HtmlToTextOptions } from "html-to-text";

/** Input caps: beyond these the remainder is dropped (reported via `capped`). */
export const MAX_PLAIN_CHARS = 2_000_000;
export const MAX_HTML_CHARS = 2_000_000;
/** Above this many tags HTML is stripped linearly instead of parsed. */
export const MAX_HTML_TAGS = 30_000;
/** Tag budget for list previews (only the first ~200 characters matter). */
export const PREVIEW_HTML_TAGS = 5_000;

const HTML_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  preserveNewlines: false,
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

const HTML_OPTIONS_KEEP_NEWLINES: HtmlToTextOptions = { ...HTML_OPTIONS, preserveNewlines: true };

/** Heuristic: does a text/plain part actually contain HTML/MSO leftovers? */
export function looksLikeHtmlJunk(text: string): boolean {
  const sample = text.slice(0, 50_000);
  if (/<!--\[if\s/i.test(sample) || /<!\[endif\]-->/i.test(sample)) return true;
  if (/<\/?(table|tbody|tr|td|div|span|font|center|v:[a-z]+)\b/i.test(sample)) return true;
  const tags = sample.match(/<\/?[a-z][a-z0-9:-]*(\s[^<>]*)?>/gi)?.length ?? 0;
  const entities = sample.match(/&(nbsp|zwnj|#8203|#160|#847);/gi)?.length ?? 0;
  return tags > 10 || entities > 20;
}

/** Number of tag starts ("<x", "</x", "<!"), counting stops just above `limit`. */
export function countTags(html: string, limit: number): number {
  let count = 0;
  let i = html.indexOf("<");
  while (i >= 0 && count <= limit) {
    const c = html.charCodeAt(i + 1);
    // letters, "/" and "!"
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 47 || c === 33) count++;
    i = html.indexOf("<", i + 1);
  }
  return count;
}

export function htmlToPlain(html: string, opts: { maxTags?: number; keepNewlines?: boolean } = {}): string {
  const input = html.slice(0, MAX_HTML_CHARS);
  if (countTags(input, opts.maxTags ?? MAX_HTML_TAGS) > (opts.maxTags ?? MAX_HTML_TAGS)) {
    return tidy(stripMarkup(input));
  }
  return tidy(convert(input, opts.keepNewlines ? HTML_OPTIONS_KEEP_NEWLINES : HTML_OPTIONS));
}

const SKIP_CONTENT = new Set(["style", "script", "head", "title"]);
const BLOCK_TAGS = new Set([
  "br", "p", "div", "tr", "li", "ul", "ol", "table", "blockquote", "section", "article",
  "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "pre",
]);

/**
 * Linear-time markup stripper for HTML too large to parse: drops tags,
 * comments and style/script/head content, breaks lines at block tags,
 * keeps links as "label <url>" and decodes entities. Every indexOf
 * result is reused, so a run of "<" without ">" can't make it quadratic.
 */
export function stripMarkup(html: string): string {
  const out: string[] = [];
  const n = html.length;
  let pos = 0;
  let nextGt = -2; // -2: not searched yet, -1: none left
  let href: string | null = null;
  const findGt = (from: number): number => {
    if (nextGt === -1) return -1;
    if (nextGt < from) nextGt = html.indexOf(">", from);
    return nextGt;
  };
  while (pos < n) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) {
      out.push(decodeEntities(html.slice(pos)));
      break;
    }
    out.push(decodeEntities(html.slice(pos, lt)));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      pos = end < 0 ? n : end + 3;
      continue;
    }
    const c = html.charCodeAt(lt + 1);
    const isTag = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 47 || c === 33 || c === 63;
    const gt = isTag ? findGt(lt + 1) : -1;
    if (gt < 0) {
      // Not a tag (or never closed): keep the "<" as text.
      out.push("<");
      pos = lt + 1;
      continue;
    }
    const tag = html.slice(lt + 1, gt);
    pos = gt + 1;
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(tag);
    if (!m) continue;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (!closing && SKIP_CONTENT.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, pos);
      if (end < 0) break;
      const endGt = html.indexOf(">", end);
      pos = endGt < 0 ? n : endGt + 1;
      continue;
    }
    if (name === "a") {
      if (!closing) {
        const h = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
        href = h ? decodeEntities(h[1] ?? h[2] ?? h[3] ?? "").trim() : null;
      } else {
        if (href && /^(?:https?|mailto):/i.test(href)) out.push(` <${href}>`);
        href = null;
      }
      continue;
    }
    if (BLOCK_TAGS.has(name) || name === "td" || name === "th") out.push(name === "td" || name === "th" ? " " : "\n");
  }
  return out.join("");
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", copy: "©", reg: "®",
  mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", bull: "•", middot: "·", trade: "™", euro: "€", zwnj: "", zwj: "",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
      return whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
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
 * for spacing; keep paragraph breaks. Inside a line a run of spaces becomes
 * one space and a run containing a tab one tab (tab-separated tables stay
 * readable). Trailing whitespace is dropped; leading indentation only when
 * `keepIndent` is false. Linear time: each whitespace run is matched once
 * and classified by its neighbours.
 */
export function tidy(text: string, keepIndent = false): string {
  const out = text
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(SPACE_LIKE, " ")
    .replace(INVISIBLE, "")
    .replace(/[ \t\f\v]+/g, (run: string, offset: number, s: string) => {
      const next = s.charCodeAt(offset + run.length);
      if (next === 10 || Number.isNaN(next)) return "";
      if (offset === 0 || s.charCodeAt(offset - 1) === 10) return keepIndent ? run.replace(/[\f\v]/g, " ") : "";
      return run.includes("\t") ? "\t" : " ";
    })
    .replace(/\n{3,}/g, "\n\n");
  let start = 0;
  while (start < out.length && out.charCodeAt(start) === 10) start++;
  return out.slice(start).trimEnd();
}

export type BodySource = "text" | "html" | "none";

/** Pick the best readable text for a message. `capped`: the part was longer than the input cap. */
export function readableBody(parsed: {
  text?: string | null;
  html?: string | false | null;
}): { text: string; source: BodySource; capped: boolean } {
  const rawPlain = typeof parsed.text === "string" ? parsed.text : "";
  const rawHtml = typeof parsed.html === "string" ? parsed.html : "";
  const plain = rawPlain.slice(0, MAX_PLAIN_CHARS);
  const html = rawHtml.slice(0, MAX_HTML_CHARS);
  if (plain.trim() && !looksLikeHtmlJunk(plain)) {
    return { text: tidy(plain, true), source: "text", capped: rawPlain.length > MAX_PLAIN_CHARS };
  }
  if (html.trim()) {
    return { text: htmlToPlain(html), source: "html", capped: rawHtml.length > MAX_HTML_CHARS };
  }
  if (plain.trim()) {
    // Junky text/plain and no HTML part: strip what we can.
    return { text: cleanJunkPlain(plain), source: "text", capped: rawPlain.length > MAX_PLAIN_CHARS };
  }
  return { text: "", source: "none", capped: false };
}

/**
 * Best effort for a text/plain part full of HTML/MSO leftovers when there
 * is no HTML part to fall back to: drop tags and comments (keeping line
 * breaks, "<https://…>" links and "<name@host>" addresses), then the
 * Markdown-style image and table residue some generators emit.
 * (Character classes exclude the opening delimiter so these stay linear.)
 */
export function cleanJunkPlain(text: string): string {
  const saved: string[] = [];
  const shielded = text.replace(
    /<((?:https?|mailto):[^\s<>]+|[^\s<>@]+@[^\s<>@]+)>/gi,
    (_m: string, inner: string) => {
      saved.push(inner);
      return `\ue000${saved.length - 1}\ue001`;
    }
  );
  return tidy(
    htmlToPlain(shielded, { keepNewlines: true })
      .replace(/\ue000(\d+)\ue001/g, (_m: string, i: string) => `<${saved[Number(i)] ?? ""}>`)
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

/** An unfinished reference ("[12", "[12 → host") or a lone "[" at the end of a string. */
const OPEN_MARKER = /\[\d+(?: (?:→[^\]\n]*)?)?$|\[$/;

/**
 * Return about `max` characters starting at `offset`. When the window ends
 * mid text, it is pulled back to the last line break or space within the
 * final 10% so words aren't cut, never ends inside a "[12]" reference or a
 * surrogate pair, and next_offset continues exactly where it stopped.
 */
export function windowText(full: string, offset: number, max: number): TextWindow {
  const total = full.length;
  const size = Math.max(2, max);
  let start = Math.min(Math.max(0, offset), total);
  if (start > 0 && start < total && isLowSurrogate(full.charCodeAt(start)) && isHighSurrogate(full.charCodeAt(start - 1))) {
    start--;
  }
  let end = Math.min(start + size, total);
  if (end < total) {
    const slice = full.slice(start, end);
    const floor = Math.floor(slice.length * 0.9);
    const nl = slice.lastIndexOf("\n");
    const sp = slice.lastIndexOf(" ");
    const cut = nl >= floor ? nl : sp >= floor ? sp : -1;
    if (cut > 0) end = start + cut + 1;
    // Don't split a reference marker or a surrogate pair.
    const tailFrom = Math.max(start, end - 320);
    const marker = OPEN_MARKER.exec(full.slice(tailFrom, end));
    if (marker && tailFrom + marker.index > start) end = tailFrom + marker.index;
    if (end > start + 1 && isHighSurrogate(full.charCodeAt(end - 1))) end--;
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
 * One pass, in reading order, over:
 *   1. "label <url>" (html-to-text output, also common in text/plain);
 *   2. bare URLs (only those of LONG_URL_CHARS or more are replaced);
 *   3. a mail's own "[n]" that is not part of a word or of "x[1][2]".
 * A URL is matched before any "[n]" inside it, so URLs and code like
 * items[0] are never altered.
 */
const LINK_OR_REF = /\s?<((?:https?|mailto):[^\s<>]+)>|\bhttps?:\/\/[^\s<>"']+|(?<![\w\]])\[(\d{1,6})\]/gi;

/**
 * Replace links with numbered references and return the URLs separately:
 *   - "label <url>" → "label [n]"; when the label itself looks like an
 *     address on another host (the classic phishing pattern), the real
 *     host stays visible: "label [n → real.host]";
 *   - bare URLs of LONG_URL_CHARS or more (tracking links, image links whose
 *     label was an image) → "[n]".
 * Short bare URLs stay inline. Repeated URLs share one number. Bracketed
 * numbers already present in the mail ("[1]") are rewritten to "(1)" so
 * they can't be confused with our references.
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
  const out = text.replace(
    LINK_OR_REF,
    (match: string, bracketed: string | undefined, own: string | undefined, offset: number, whole: string) => {
      if (bracketed) {
        const n = ref(bracketed);
        const host = mismatchedHost(whole, offset, bracketed);
        return host ? ` [${n} → ${host}]` : ` [${n}]`;
      }
      if (own) return `(${own})`;
      const end = trimUrlEnd(match);
      const clean = match.slice(0, end);
      return clean.length >= LONG_URL_CHARS ? `[${ref(clean)}]${match.slice(end)}` : match;
    }
  );
  return { text: out, links };
}

/**
 * Length of a bare URL without trailing sentence punctuation. A closing
 * ")" or "]" is kept while the URL has unmatched opening brackets of that
 * kind (Wikipedia-style "/Foo_(bar)"). Counts once, then a plain loop.
 */
function trimUrlEnd(url: string): number {
  let parens = 0;
  let squares = 0;
  for (let i = 0; i < url.length; i++) {
    const c = url[i];
    if (c === "(") parens++;
    else if (c === ")") parens--;
    else if (c === "[") squares++;
    else if (c === "]") squares--;
  }
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if (".,;:!?".includes(c)) {
      end--;
    } else if (c === ")" && parens < 0) {
      parens++;
      end--;
    } else if (c === "]" && squares < 0) {
      squares++;
      end--;
    } else {
      break;
    }
  }
  return end;
}

const HOST_LIKE = /^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:[:/?#]|$)/i;

const bareHost = (h: string): string => h.toLowerCase().replace(/^www\./, "");

/**
 * When the text right before " <href>" (the link label) is itself a URL or
 * domain on a different host than href, return href's host.
 */
function mismatchedHost(whole: string, offset: number, href: string): string | null {
  const before = whole.slice(Math.max(0, offset - 256), offset);
  const token = (before.split(/\s/).pop() ?? "").replace(/^[("'«]+|[.,;:!?)"'»]+$/g, "");
  const label = HOST_LIKE.exec(token);
  if (!label) return null;
  let target: string;
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    target = u.hostname;
  } catch {
    return null;
  }
  const a = bareHost(label[1]);
  const b = bareHost(target);
  if (a === b || b.endsWith(`.${a}`)) return null;
  return target.toLowerCase();
}

const REF = /\[(\d+)(?: → [^\]\n]*)?\]/g;

/** Links referenced as [n] (or [n → host]) inside a piece of text, keyed by number. */
export function linksIn(text: string, links: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(REF)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= links.length) out[n] = links[n - 1];
  }
  return out;
}

/** Text for one-line previews: no URLs, no reference markers. */
export function stripLinks(text: string): string {
  return text
    .replace(/\s?<(?:https?|mailto):[^\s<>]+>/gi, "")
    .replace(/\s?\[\d+(?: → [^\]\n]*)?\]/g, "")
    .replace(/\bhttps?:\/\/\S+/gi, "");
}
