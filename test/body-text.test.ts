import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeHtmlJunk, readableBody, previewOf, windowText, htmlToPlain } from "../src/body-text.js";
import { footnoteLinks, linksIn, stripLinks, cleanJunkPlain, MAX_PLAIN_CHARS } from "../src/body-text.js";
import { textParts, decodePart, ImapClient } from "../src/imap-client.js";

const MSO_PLAIN = `Community Blog\n\n<!--[if gte mso 9]>\n<v:background fill="t"/>\n<![endif]-->\n|<!--[if mso]><td align="center"><![endif]-->\n| Hello&nbsp;&nbsp;families`;
const NEWSLETTER_HTML = `<html><head><style>.x{color:red}</style></head><body>
<div style="display:none">preheader filler text</div>
<table role="presentation"><tr><td><h2>Weekly Bulletin</h2></td></tr>
<tr><td><img src="https://cdn.example.com/a.png" alt="Staff photo"><p>Friendly reminder, the office is open&nbsp;tomorrow!</p>
<p>Read more <a href="https://newsletter.example.com/posts/123">on the website</a> or visit <a href="https://example.org">https://example.org</a>.</p></td></tr></table>
</body></html>`;

test("text/plain with MSO comments is detected as junk", () => {
  assert.equal(looksLikeHtmlJunk(MSO_PLAIN), true);
  assert.equal(looksLikeHtmlJunk("Hi Viktor,\n\nThe build passed. See <https://github.com/x/y/pull/1>.\n\nThanks"), false);
});

test("junky text/plain falls back to HTML conversion", () => {
  const r = readableBody({ text: MSO_PLAIN, html: NEWSLETTER_HTML });
  assert.equal(r.source, "html");
  assert.doesNotMatch(r.text, /<!--|<td|<table|&nbsp;|\.x\{|cdn\.example\.com|preheader filler/);
  assert.match(r.text, /Weekly Bulletin/);
  assert.match(r.text, /office is open tomorrow!/);
  assert.match(r.text, /on the website <https:\/\/newsletter\.example\.com\/posts\/123>/);
  // URL equal to its label is not repeated
  assert.match(r.text, /visit https:\/\/example\.org\./);
  assert.doesNotMatch(r.text, /\n{3,}/);
});

test("clean text/plain is used as-is (tidied)", () => {
  const r = readableBody({ text: "Hello there\r\n\r\n\r\n\r\nBye ​", html: NEWSLETTER_HTML });
  assert.equal(r.source, "text");
  assert.equal(r.text, "Hello there\n\nBye");
});

test("html-only and empty messages", () => {
  assert.equal(readableBody({ html: "<p>Only <b>html</b></p>" }).text, "Only html");
  assert.deepEqual(readableBody({}), { text: "", source: "none", capped: false });
  assert.equal(htmlToPlain("<h1>Title</h1><p>x</p>"), "Title\n\nx");
});

test("preview is one line and capped", () => {
  assert.equal(previewOf("a\n\n b"), "a b");
  const p = previewOf("x".repeat(500))!;
  assert.equal(p.length, 200);
  assert.ok(p.endsWith("…"));
  assert.equal(previewOf("   "), null);
});

test("windowText pages through the whole text without loss", () => {
  const words = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" ");
  let offset = 0;
  let rebuilt = "";
  let pages = 0;
  for (;;) {
    const w = windowText(words, offset, 5000);
    assert.equal(w.total_length, words.length);
    assert.ok(w.text.length <= 5000);
    rebuilt += w.text;
    pages++;
    if (!w.truncated) {
      assert.equal(w.next_offset, null);
      break;
    }
    assert.ok(/\s$/.test(w.text), "page should end on a word boundary");
    offset = w.next_offset!;
  }
  assert.equal(rebuilt, words);
  assert.ok(pages > 1);
  assert.deepEqual(windowText("short", 0, 15000), { text: "short", offset: 0, total_length: 5, truncated: false, next_offset: null });
  assert.equal(windowText("short", 99, 10).text, "");
});


test("links become numbered references; repeats share a number", () => {
  const long = "https://click.example.com/ls/click?upn=" + "x".repeat(400);
  const { text, links } = footnoteLinks(`Click here <${long}> to sign up.\nAgain <${long}>, or <https://example.org/b>.`);
  assert.equal(text, "Click here [1] to sign up.\nAgain [1], or [2].");
  assert.deepEqual(links, [long, "https://example.org/b"]);
  assert.deepEqual(linksIn("only [2] here", links), { 2: "https://example.org/b" });
  assert.deepEqual(linksIn("[9] out of range", links), {});
});

test("previews drop URLs and reference markers", () => {
  assert.equal(stripLinks("Read <https://a.b/c> now [3] or https://x.y/z ok").replace(/\s+/g, " "), "Read now or ok");
});

test("junky text/plain without HTML part is cleaned of image/table residue", () => {
  const junk = "<!--[if mso]><td><![endif]-->\n| \n## Weekly Bulletin\n| \n ![Staff photo](https://cdn.x/a.png)\n |\nHello everyone";
  const out = cleanJunkPlain(junk);
  assert.doesNotMatch(out, /!\[|\]\(|^\s*\|/m);
  assert.doesNotMatch(out, /##/);
  assert.match(out, /Weekly Bulletin/);
  assert.match(out, /Hello everyone/);
  assert.equal(readableBody({ text: junk }).text, out);
});

test("textParts picks inline text parts and skips attachments", () => {
  const alt = { type: "multipart/alternative", childNodes: [{ part: "1", type: "text/plain" }, { part: "2", type: "text/html" }] };
  assert.deepEqual(textParts(alt as never), { plain: "1", html: "2" });
  const mixed = {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "multipart/alternative", childNodes: [{ part: "1.1", type: "text/plain" }, { part: "1.2", type: "text/html" }] },
      { part: "2", type: "text/plain", disposition: "attachment" },
      { part: "3", type: "message/rfc822", childNodes: [{ part: "3.1", type: "text/plain" }] },
    ],
  };
  assert.deepEqual(textParts(mixed as never), { plain: "1.1", html: "1.2" });
  assert.deepEqual(textParts({ type: "text/html" } as never), { html: "1" });
  assert.deepEqual(textParts({ type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain", disposition: "attachment" }] } as never), {});
});


test("decodePart handles truncated base64 / quoted-printable and charsets", () => {
  const b64 = Buffer.from(Buffer.from("Привет, мир! Hello").toString("base64"));
  assert.equal(decodePart(b64, { encoding: "base64", charset: "utf-8" }), "Привет, мир! Hello");
  // cut mid-quantum: incomplete tail is dropped, not garbled
  assert.match(decodePart(b64.subarray(0, b64.length - 3), { encoding: "base64", charset: "utf-8" }), /^Привет, мир!/);
  assert.equal(decodePart(Buffer.from("Gr=C3=BC=C3=9Fe=\r\n aus=20Berlin=C"), { encoding: "quoted-printable", charset: "utf-8" }), "Grüße aus Berlin");
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  assert.equal(decodePart(cp1251, { encoding: "8bit", charset: "windows-1251" }), "Привет");
  assert.equal(decodePart(Buffer.from("plain"), { encoding: "7bit", charset: "x-unknown-charset" }), "plain");
});

test("previews are fetched in batches per part number, not per message", async () => {
  const imap = new ImapClient({ host: "x", port: 993, user: "u", pass: "p", secure: true });
  const fetches: string[] = [];
  const bodies: Record<string, string> = { "1": "Hello from one", "2": "Hello from two", "3": "Hello from three" };
  const fake = {
    fetch: async function* (range: string, query: { bodyParts: { key: string }[] }) {
      fetches.push(`${query.bodyParts[0].key}:${range}`);
      for (const uid of range.split(",").map(Number)) {
        yield { uid, bodyParts: new Map([[`${query.bodyParts[0].key}]<0>`, Buffer.from(bodies[uid])]]) };
      }
    },
  };
  const msgs = [1, 2, 3].map((uid) => ({
    uid,
    bodyStructure: uid === 3
      ? { type: "text/plain", encoding: "7bit" }
      : { type: "multipart/alternative", childNodes: [{ part: "1", type: "text/plain", encoding: "7bit" }, { part: "2", type: "text/html" }] },
  }));
  const previews = await (imap as unknown as { previewsFor: (c: unknown, m: unknown) => Promise<Map<number, string>> }).previewsFor(fake, msgs);
  assert.deepEqual([...previews.entries()].sort(), [[1, "Hello from one"], [2, "Hello from two"], [3, "Hello from three"]]);
  assert.deepEqual(fetches, ["1:1,2,3"]);
});

// ---- hostile input, links, paging edges ------------------------------------------

const timed = <T>(fn: () => T): { ms: number; out: T } => {
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
};

test("hostile inputs stay linear-time", () => {
  const MB = 1_000_000;
  const cases: [string, () => unknown][] = [
    ["1 MB of spaces without newline (tidy)", () => readableBody({ text: "x" + " ".repeat(MB) + "y" })],
    ["1 MB of NBSP (tidy)", () => readableBody({ text: "x" + " ".repeat(MB) + "y" })],
    ["200 KB of '![' (cleanJunkPlain)", () => cleanJunkPlain("<td>" + "![".repeat(100_000))],
    ["200 KB of U+2028 after '|' (cleanJunkPlain)", () => cleanJunkPlain("<td>|" + " ".repeat(200_000) + "x")],
    ["URL ending in 500 KB of ')' (footnoteLinks)", () => footnoteLinks("https://e.com/" + ")".repeat(500_000) + "x")],
    ["500 KB HTML <pre> whitespace", () => htmlToPlain("<pre>" + " ".repeat(500_000) + "</pre>")],
  ];
  for (const [name, fn] of cases) {
    const { ms } = timed(fn);
    assert.ok(ms < 1500, `${name} took ${Math.round(ms)} ms`);
  }
});

test("deeply nested HTML converts instead of overflowing the stack", () => {
  const html = "<span>".repeat(5000) + "deep text";
  const out = readableBody({ html });
  assert.equal(out.source, "html");
  assert.doesNotThrow(() => htmlToPlain(html));
});

test("Unicode layout spaces and blank letters collapse like spaces", () => {
  const text = "Order date\n ㅤ⠀\n\n​\n\nDelivered next";
  assert.equal(readableBody({ text }).text, "Order date\n\nDelivered\nnext");
});

test("long bare URLs become references; short ones stay; mail's own [1] becomes (1)", () => {
  const long = "https://w-mt.co/g/rptrcks/clickTracker?redirectTo=" + "A".repeat(200);
  const { text, links } = footnoteLinks(`${long}\nSee note [1] and https://example.org/x.\nAgain ${long}).`);
  assert.equal(text, "[1]\nSee note (1) and https://example.org/x.\nAgain [1]).");
  assert.deepEqual(links, [long]);
});

test("windowText never splits a surrogate pair or a [n] reference", () => {
  const emoji = "😀".repeat(3000); // no spaces: hard cuts
  let off = 0;
  let rebuilt = "";
  for (;;) {
    const w = windowText(emoji, off, 1001);
    assert.ok(!/[\ud800-\udbff]$/.test(w.text), "page ends with a lone high surrogate");
    assert.ok(!/^[\udc00-\udfff]/.test(w.text), "page starts with a lone low surrogate");
    rebuilt += w.text;
    if (!w.truncated) break;
    off = w.next_offset!;
  }
  assert.equal(rebuilt, emoji);
  const refs = "x".repeat(995) + "[123]" + "y".repeat(100);
  const w = windowText(refs, 0, 998);
  assert.ok(w.text.endsWith("x"), "must stop before the '[123]' marker");
  assert.equal(windowText(refs, w.next_offset!, 50).text.slice(0, 5), "[123]");
  // A caller-supplied offset inside a pair is realigned.
  assert.equal(windowText("a😀b", 2, 10).text, "😀b");
});

test("previewOf never ends on a lone surrogate", () => {
  const p = previewOf("😀".repeat(300))!;
  assert.ok(!/[\ud800-\udbff]…$/.test(p));
});

test("decodePart keeps the last base64 quantum of complete parts", () => {
  for (const s of ["OK", "Hello world", "Привет"]) {
    const b64 = Buffer.from(Buffer.from(s).toString("base64") + "\r\n");
    assert.equal(decodePart(b64, { encoding: "base64", charset: "utf-8" }), s);
  }
});

// ---- review round 2 ---------------------------------------------------------------

test("HTML too large to parse safely is stripped linearly (no quadratic parse, no huge DOM)", () => {
  const cases: [string, string][] = [
    ["400k unclosed <b>", "<b>".repeat(400_000) + "text"],
    ["500k <br> (2 MB)", "<br>".repeat(500_000)],
    ["100k <b> then 100k unmatched </i>", "<b>".repeat(100_000) + "</i>".repeat(100_000)],
    ["500k '<a' without '>'", "<a".repeat(500_000)],
    ["200k '<style' without a closing tag", "<style>".repeat(200_000)],
  ];
  for (const [name, html] of cases) {
    const { ms } = timed(() => readableBody({ html }));
    assert.ok(ms < 1500, `${name} took ${Math.round(ms)} ms`);
  }
  // Just under the tag cap the real parser runs and is still fast enough.
  const { ms } = timed(() => htmlToPlain("<b>".repeat(15_000) + "</i>".repeat(14_000) + "x"));
  assert.ok(ms < 3000, `parse at the cap took ${Math.round(ms)} ms`);
});

test("the linear stripper keeps text, links, entities and line breaks", () => {
  const html =
    '<style>.a{}</style><p>Hello &amp; welcome</p><a href="https://x.example/a">Shop</a><br>Line<!-- c > d -->end &#8364;' +
    "<i></i>".repeat(20_000);
  assert.equal(htmlToPlain(html), "Hello & welcome\nShop <https://x.example/a>\nLineend €");
});

test("mso-hide:all blocks (Outlook buttons) are kept", () => {
  const out = htmlToPlain('<div style="mso-hide:all"><a href="https://x.example/buy">Buy now</a></div>');
  assert.match(out, /Buy now <https:\/\/x\.example\/buy>/);
});

test("[n] inside URLs and code is left alone; a mail's own [n] becomes (n)", () => {
  const { text, links } = footnoteLinks(
    "See https://shop.example.com/s?filter[0]=a&filter[1]=b and <https://e.example/?ids[0]=7> code: items[0] and m[1][2]; note [2]."
  );
  assert.equal(text, "See https://shop.example.com/s?filter[0]=a&filter[1]=b and [1] code: items[0] and m[1][2]; note (2).");
  assert.deepEqual(links, ["https://e.example/?ids[0]=7"]);
});

test("a closing bracket that belongs to a long URL is kept", () => {
  const wiki = "https://en.wikipedia.org/wiki/" + "A".repeat(90) + "_(disambiguation)";
  const { text, links } = footnoteLinks(`(see ${wiki}).`);
  assert.equal(text, "(see [1]).");
  assert.deepEqual(links, [wiki]);
});

test("a link whose visible text names another host shows the real host", () => {
  const { text, links } = footnoteLinks(
    "Sign in at https://www.paypal.com/signin <https://evil.example.net/x> now. Or www.example.com <https://click.example.com/t>. Or Shop <https://evil.example.net/y>."
  );
  assert.equal(text, "Sign in at https://www.paypal.com/signin [1 → evil.example.net] now. Or www.example.com [2]. Or Shop [3].");
  assert.deepEqual(Object.keys(linksIn(text, links)), ["1", "2", "3"]);
  assert.equal(stripLinks(text).replace(/\s+/g, " "), "Sign in at now. Or www.example.com. Or Shop.");
  // A page never ends inside such a marker.
  const w = windowText(text, 0, text.indexOf("evil") + 2);
  assert.ok(!/\[1[^\]]*$/.test(w.text), w.text);
});

test("plain-text mail keeps tabs and indentation; trailing spaces go", () => {
  const r = readableBody({ text: "Name\tQty\nApple\t3\n    indented code\nend   " });
  assert.equal(r.text, "Name\tQty\nApple\t3\n    indented code\nend");
});

test("junk text/plain cleanup keeps <https://...> links, <addresses> and line breaks", () => {
  const out = cleanJunkPlain("<td>Hi</td>\nSee <https://a.example/x> or write <me@example.com>\nBye");
  assert.match(out, /<https:\/\/a\.example\/x>/);
  assert.match(out, /<me@example\.com>/);
  assert.match(out, /\nBye$/);
});

test("a body over the input cap is reported as capped", () => {
  assert.equal(readableBody({ text: "a ".repeat(MAX_PLAIN_CHARS / 2 + 10) }).capped, true);
  assert.equal(readableBody({ text: "short" }).capped, false);
});

test("windowText with max 1 still pages through emoji", () => {
  const s = "😀😀😀";
  let off = 0;
  let rebuilt = "";
  for (let i = 0; i < 10; i++) {
    const w = windowText(s, off, 1);
    rebuilt += w.text;
    if (!w.truncated) break;
    off = w.next_offset!;
  }
  assert.equal(rebuilt, s);
});

test("long bare URLs keep the brackets, quotes and punctuation around them", () => {
  const url = "https://docs.google.com/forms/d/e/" + "A".repeat(90) + "/viewform?usp=sf_link";
  const wiki = "https://en.wikipedia.org/wiki/" + "B".repeat(90) + "_(disambiguation)";
  const cases: [string, string][] = [
    [`**[Harvest Party sign up](${url})**`, "**[Harvest Party sign up]([1])**"],
    [`[Sign up](${url})`, "[Sign up]([1])"],
    [`_[Sign up](${url})_`, "_[Sign up]([1])_"],
    [`(see ${url})`, "(see [1])"],
    [`(see ${url}).`, "(see [1])."],
    [`Sign up at ${url}.`, "Sign up at [1]."],
    [`Is it ${url}?!`, "Is it [1]?!"],
    [`“${url}”`, "“[1]”"],
    [`«${url}»,`, "«[1]»,"],
    [`{${url}}`, "{[1]}"],
    [`(${wiki})`, "([1])"],
  ];
  for (const [input, expected] of cases) {
    const { text, links } = footnoteLinks(input);
    assert.equal(text, expected, input.slice(0, 30));
    assert.equal(links[0], input.includes(wiki) ? wiki : url, `URL kept whole: ${input.slice(0, 30)}`);
  }
});
