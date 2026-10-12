import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeHtmlJunk, readableBody, previewOf, windowText, htmlToPlain } from "../src/body-text.js";
import { footnoteLinks, linksIn, stripLinks, cleanJunkPlain } from "../src/body-text.js";
import { textParts } from "../src/imap-client.js";

const MSO_PLAIN = `Community Blog\n\n<!--[if gte mso 9]>\n<v:background fill="t"/>\n<![endif]-->\n|<!--[if mso]><td align="center"><![endif]-->\n| Hello&nbsp;&nbsp;families`;
const NEWSLETTER_HTML = `<html><head><style>.x{color:red}</style></head><body>
<div style="display:none">preheader filler text</div>
<table role="presentation"><tr><td><h2>Timberwolf Times</h2></td></tr>
<tr><td><img src="https://cdn.example.com/a.png" alt="Mrs. Spears"><p>Friendly reminder, we have school&nbsp;tomorrow!</p>
<p>Read more <a href="https://www.parentsquare.com/feeds/123">on ParentSquare</a> or visit <a href="https://example.org">https://example.org</a>.</p></td></tr></table>
</body></html>`;

test("text/plain with MSO comments is detected as junk", () => {
  assert.equal(looksLikeHtmlJunk(MSO_PLAIN), true);
  assert.equal(looksLikeHtmlJunk("Hi Viktor,\n\nThe build passed. See <https://github.com/x/y/pull/1>.\n\nThanks"), false);
});

test("junky text/plain falls back to HTML conversion", () => {
  const r = readableBody({ text: MSO_PLAIN, html: NEWSLETTER_HTML });
  assert.equal(r.source, "html");
  assert.doesNotMatch(r.text, /<!--|<td|<table|&nbsp;|\.x\{|cdn\.example\.com|preheader filler/);
  assert.match(r.text, /Timberwolf Times/);
  assert.match(r.text, /school tomorrow!/);
  assert.match(r.text, /on ParentSquare <https:\/\/www\.parentsquare\.com\/feeds\/123>/);
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
  assert.deepEqual(readableBody({}), { text: "", source: "none" });
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
  const long = "https://email-link.parentsquare.com/ls/click?upn=" + "x".repeat(400);
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
  const junk = "<!--[if mso]><td><![endif]-->\n| \n## Timberwolf Times\n| \n ![Mrs. Spears](https://cdn.x/a.png)\n |\nHello families";
  const out = cleanJunkPlain(junk);
  assert.doesNotMatch(out, /!\[|\]\(|^\s*\|/m);
  assert.doesNotMatch(out, /##/);
  assert.match(out, /Timberwolf Times/);
  assert.match(out, /Hello families/);
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
