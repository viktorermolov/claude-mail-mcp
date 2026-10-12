import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeHtmlJunk, readableBody, previewOf, windowText, htmlToPlain } from "../src/body-text.js";

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
