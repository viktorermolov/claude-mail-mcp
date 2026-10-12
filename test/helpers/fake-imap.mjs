// In-memory fake IMAP4rev1 server for driving the real imapflow (through
// ImapClient) in tests. It never talks to a real mail server. Every command
// is recorded together with the connection's selected mailbox and mode, so
// tests can assert exactly what went over the wire (no plain EXPUNGE, no
// CLOSE, reads only EXAMINE + BODY.PEEK, ...). Hooks inject faults.
import net from "node:net";

function tokenize(text, literals) {
  let i = 0;
  const parseList = (closer) => {
    const out = [];
    while (i < text.length) {
      const c = text[i];
      if (c === " ") { i++; continue; }
      if (c === closer) { i++; return out; }
      if (c === "(") { i++; out.push(parseList(")")); continue; }
      if (c === '"') {
        i++;
        let s = "";
        while (i < text.length && text[i] !== '"') {
          if (text[i] === "\\") i++;
          s += text[i++];
        }
        i++;
        out.push(s);
        continue;
      }
      if (c === "\x00") {
        const end = text.indexOf("\x00", i + 1);
        out.push(literals[Number(text.slice(i + 4, end))]);
        i = end + 1;
        continue;
      }
      let s = "";
      let depth = 0;
      while (i < text.length) {
        const ch = text[i];
        if (ch === "[") depth++;
        if (ch === "]") depth--;
        if (depth === 0 && (ch === " " || ch === ")" || ch === "(")) break;
        s += ch;
        i++;
      }
      out.push(s);
    }
    return out;
  };
  return parseList(null);
}

const flat = (v) => (Array.isArray(v) ? v.flatMap(flat) : [v]);

function inSet(set, n, max) {
  for (const part of String(set).split(",")) {
    const [a, b] = part.split(":");
    const lo = a === "*" ? max : Number(a);
    const hi = b === undefined ? lo : b === "*" ? max : Number(b);
    if (n >= Math.min(lo, hi) && n <= Math.max(lo, hi)) return true;
  }
  return false;
}

const q = (s) => (s == null ? "NIL" : `"${String(s).replace(/(["\\])/g, "\\$1")}"`);

function splitMessage(raw) {
  const s = raw.toString("latin1");
  const idx = s.indexOf("\r\n\r\n");
  const head = idx < 0 ? s : s.slice(0, idx);
  const body = idx < 0 ? "" : s.slice(idx + 4);
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, head, body };
}

function addrList(v) {
  if (!v) return "NIL";
  const m = /^(?:"?([^"<]*)"?\s*)?<?([^<>@\s]+)@([^<>\s]+?)>?$/.exec(v.trim());
  if (!m) return "NIL";
  return `((${m[1] && m[1].trim() ? q(m[1].trim()) : "NIL"} NIL ${q(m[2])} ${q(m[3])}))`;
}

export class FakeImapServer {
  constructor(opts = {}) {
    this.opts = {
      caps: ["IMAP4rev1", "UIDPLUS", "IDLE", "NAMESPACE", "LITERAL+"],
      ...opts,
    };
    this.hooks = opts.hooks || {};
    this.boxes = new Map();
    this.log = [];
    this.connSeq = 0;
    this.logins = 0;
    this.sockets = new Set();
    this.nextId = 1;
  }

  addBox(name, specialUse, extraFlags = []) {
    this.boxes.set(name, {
      name, specialUse, extraFlags, uidValidity: 1000 + this.boxes.size, uidNext: 1, messages: [],
      permanentFlags: ["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft", "\\*"],
    });
    return this;
  }

  addMessage(box, raw, flags = []) {
    const b = this.boxes.get(box);
    const uid = b.uidNext++;
    const id = `m${this.nextId++}`;
    b.messages.push({ uid, flags: new Set(flags), raw: Buffer.from(raw), id });
    return { uid, id };
  }

  resolve(name) {
    if (name == null) return null;
    if (String(name).toUpperCase() === "INBOX") return this.boxes.has("INBOX") ? "INBOX" : null;
    if (this.opts.caseInsensitive) {
      for (const k of this.boxes.keys()) if (k.toLowerCase() === String(name).toLowerCase()) return k;
    }
    return this.boxes.has(name) ? name : null;
  }

  ids(box) {
    return this.boxes.get(box).messages.map((m) => m.id);
  }

  find(id) {
    const out = [];
    for (const [k, b] of this.boxes) for (const m of b.messages) if (m.id === id) out.push({ box: k, uid: m.uid, flags: [...m.flags] });
    return out;
  }

  commands() {
    return this.log.map((e) => e.cmd);
  }

  listen() {
    this.server = net.createServer((sock) => this.onConn(sock));
    return new Promise((r) => this.server.listen(0, "127.0.0.1", () => r(this.server.address().port)));
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(() => r()));
  }

  onConn(sock) {
    const conn = { id: ++this.connSeq, sock, selected: null, readOnly: false, idleTag: null };
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => {});
    const w = (s) => { if (!sock.destroyed) sock.write(s + "\r\n"); };
    conn.w = w;
    w(`* OK fake imap ready`);
    let buf = Buffer.alloc(0);
    let st = { text: "", literals: [], need: -1 };
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (st.need >= 0) {
          if (buf.length < st.need) return;
          st.literals.push(buf.subarray(0, st.need));
          buf = buf.subarray(st.need);
          st.need = -1;
          continue;
        }
        const idx = buf.indexOf("\r\n");
        if (idx < 0) return;
        const line = buf.subarray(0, idx).toString("binary");
        buf = buf.subarray(idx + 2);
        if (conn.idleTag) {
          if (line.trim().toUpperCase() === "DONE") { const t = conn.idleTag; conn.idleTag = null; w(`${t} OK idle done`); }
          continue;
        }
        const m = line.match(/\{(\d+)(\+?)\}$/);
        if (m) {
          st.text += line.slice(0, line.length - m[0].length) + `\x00LIT${st.literals.length}\x00`;
          st.need = Number(m[1]);
          if (!m[2]) w("+ go ahead");
          continue;
        }
        st.text += line;
        const text = st.text, lits = st.literals;
        st = { text: "", literals: [], need: -1 };
        try { this.handle(conn, text, lits); } catch (e) { w(`* BAD internal ${e.message}`); }
      }
    });
  }

  handle(conn, text, lits) {
    const w = conn.w;
    const toks = tokenize(text, lits);
    const tag = toks[0];
    let cmd = String(toks[1] || "").toUpperCase();
    let args = toks.slice(2);
    if (cmd === "UID") { cmd = "UID " + String(args[0]).toUpperCase(); args = args.slice(1); }
    this.log.push({
      conn: conn.id, selected: conn.selected, readOnly: conn.readOnly, cmd,
      text: text.replace(/\x00LIT\d+\x00/g, "{literal}").replace(/^(\S+) LOGIN .*/, "$1 LOGIN ***"),
    });
    if (this.hooks.onCommand && this.hooks.onCommand(conn, tag, cmd, args, this) === "handled") return;
    const caps = this.opts.caps.join(" ");
    const box = conn.selected ? this.boxes.get(conn.selected) : null;
    switch (cmd) {
      case "CAPABILITY": w(`* CAPABILITY ${caps}`); return w(`${tag} OK done`);
      case "LOGIN":
        this.logins++;
        if (this.hooks.loginFail && this.hooks.loginFail(this.logins, this)) return w(`${tag} NO [AUTHENTICATIONFAILED] nope`);
        return w(`${tag} OK [CAPABILITY ${caps}] logged in`);
      case "NAMESPACE": w(`* NAMESPACE (("" "/")) NIL NIL`); return w(`${tag} OK done`);
      case "ID": w(`* ID NIL`); return w(`${tag} OK done`);
      case "ENABLE": w(`* ENABLED`); return w(`${tag} OK done`);
      case "NOOP": return w(`${tag} OK noop`);
      case "LOGOUT": w(`* BYE bye`); w(`${tag} OK bye`); return conn.sock.end();
      case "IDLE": conn.idleTag = tag; return w(`+ idling`);
      case "LIST": case "LSUB": {
        const pattern = String(args[1] ?? "");
        if (pattern === "") { w(`* ${cmd} (\\Noselect) "/" ""`); return w(`${tag} OK done`); }
        for (const b of this.boxes.values()) {
          const fl = ["\\HasNoChildren", ...b.extraFlags];
          if (b.specialUse && cmd === "LIST") fl.push(b.specialUse);
          w(`* ${cmd} (${fl.join(" ")}) "/" ${q(b.name)}`);
        }
        return w(`${tag} OK done`);
      }
      case "SELECT": case "EXAMINE": {
        const name = this.resolve(args[0]);
        if (!name) { conn.selected = null; return w(`${tag} NO no such mailbox`); }
        conn.selected = name; conn.readOnly = cmd === "EXAMINE";
        const b = this.boxes.get(name);
        w(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`);
        // Like real servers (RFC 3501 6.3.2), EXAMINE reports no permanent flags.
        w(`* OK [PERMANENTFLAGS (${conn.readOnly ? "" : b.permanentFlags.join(" ")})] ok`);
        w(`* ${b.messages.length} EXISTS`);
        w(`* 0 RECENT`);
        w(`* OK [UIDVALIDITY ${b.uidValidity}] ok`);
        w(`* OK [UIDNEXT ${b.uidNext}] ok`);
        return w(`${tag} OK [${conn.readOnly ? "READ-ONLY" : "READ-WRITE"}] selected`);
      }
      case "UNSELECT": conn.selected = null; return w(`${tag} OK done`);
      case "CLOSE": {
        if (box && !conn.readOnly) this.expungeWhere(conn, box, () => true, false);
        conn.selected = null; return w(`${tag} OK done`);
      }
      case "STATUS": {
        const name = this.resolve(args[0]);
        if (!name) return w(`${tag} NO no such mailbox`);
        const b = this.boxes.get(name);
        w(`* STATUS ${q(b.name)} (MESSAGES ${b.messages.length} UIDNEXT ${b.uidNext} UIDVALIDITY ${b.uidValidity} UNSEEN 0)`);
        return w(`${tag} OK done`);
      }
      case "APPEND": {
        const name = this.resolve(args[0]);
        if (!name) return w(`${tag} NO [TRYCREATE] no such mailbox`);
        const b = this.boxes.get(name);
        let flags = [];
        let raw;
        for (const a of args.slice(1)) { if (Array.isArray(a)) flags = flat(a); else if (Buffer.isBuffer(a)) raw = a; }
        const uid = b.uidNext++;
        b.messages.push({ uid, flags: new Set(flags), raw, id: `m${this.nextId++}` });
        if (conn.selected === name) w(`* ${b.messages.length} EXISTS`);
        if (this.opts.appendUidOff) return w(`${tag} OK appended`);
        return w(`${tag} OK [APPENDUID ${b.uidValidity} ${uid}] appended`);
      }
      case "UID COPY": case "COPY": {
        if (!box) return w(`${tag} BAD not selected`);
        const dest = this.resolve(args[1]);
        if (!dest) return w(`${tag} NO [TRYCREATE] no such mailbox`);
        const d = this.boxes.get(dest);
        const max = cmd === "UID COPY" ? (box.messages.at(-1)?.uid ?? 0) : box.messages.length;
        const src = [], dst = [];
        box.messages.forEach((m, i) => {
          const key = cmd === "UID COPY" ? m.uid : i + 1;
          if (inSet(args[0], key, max)) {
            const nu = d.uidNext++;
            d.messages.push({ uid: nu, flags: new Set(m.flags), raw: m.raw, id: m.id });
            src.push(m.uid); dst.push(nu);
          }
        });
        if (!src.length) return w(`${tag} OK nothing copied`);
        if (this.opts.copyUidOff) return w(`${tag} OK done`);
        return w(`${tag} OK [COPYUID ${d.uidValidity} ${src.join(",")} ${dst.join(",")}] done`);
      }
      case "UID MOVE": {
        if (!this.opts.caps.includes("MOVE")) return w(`${tag} BAD unknown command ${cmd}`);
        if (!box) return w(`${tag} BAD not selected`);
        if (conn.readOnly) return w(`${tag} NO read-only`);
        const dest = this.resolve(args[1]);
        if (!dest) return w(`${tag} NO [TRYCREATE] no such mailbox`);
        const d = this.boxes.get(dest);
        const max = box.messages.at(-1)?.uid ?? 0;
        const src = [], dst = [];
        for (let i = box.messages.length - 1; i >= 0; i--) {
          const m = box.messages[i];
          if (!inSet(args[0], m.uid, max)) continue;
          const nu = d.uidNext++;
          d.messages.push({ uid: nu, flags: new Set(m.flags), raw: m.raw, id: m.id });
          src.unshift(m.uid); dst.unshift(nu);
          box.messages.splice(i, 1);
          w(`* ${i + 1} EXPUNGE`);
        }
        if (src.length && !this.opts.copyUidOff) w(`* OK [COPYUID ${d.uidValidity} ${src.join(",")} ${dst.join(",")}] moved`);
        return w(`${tag} OK done`);
      }
      case "UID STORE": case "STORE": {
        if (!box) return w(`${tag} BAD not selected`);
        if (conn.readOnly) return w(`${tag} NO read-only`);
        const op = String(args[1]).toUpperCase();
        const flags = flat(args[2]);
        const max = cmd === "UID STORE" ? (box.messages.at(-1)?.uid ?? 0) : box.messages.length;
        box.messages.forEach((m, i) => {
          const key = cmd === "UID STORE" ? m.uid : i + 1;
          if (!inSet(args[0], key, max)) return;
          for (const f of flags) { if (op.startsWith("+")) m.flags.add(f); else if (op.startsWith("-")) m.flags.delete(f); }
          if (!op.includes("SILENT")) w(`* ${i + 1} FETCH (UID ${m.uid} FLAGS (${[...m.flags].join(" ")}))`);
        });
        return w(`${tag} OK stored`);
      }
      case "UID EXPUNGE": {
        if (!box) return w(`${tag} BAD not selected`);
        if (conn.readOnly) return w(`${tag} NO read-only`);
        const max = box.messages.at(-1)?.uid ?? 0;
        this.expungeWhere(conn, box, (m) => inSet(args[0], m.uid, max), true);
        return w(`${tag} OK expunged`);
      }
      case "EXPUNGE": {
        if (!box) return w(`${tag} BAD not selected`);
        this.expungeWhere(conn, box, () => true, true);
        return w(`${tag} OK expunged`);
      }
      case "UID SEARCH": case "SEARCH": {
        if (!box) return w(`${tag} BAD not selected`);
        const crit = flat(args).map((s) => String(s).toUpperCase());
        const hits = box.messages
          .map((m, i) => ({ m, key: cmd === "UID SEARCH" ? m.uid : i + 1 }))
          .filter(({ m }) => (crit.includes("UNSEEN") ? !m.flags.has("\\Seen") : true))
          // A bare sequence set ("SEARCH 5") filters by message number.
          .filter((_h, i) => crit.filter((c) => /^[\d:*,]+$/.test(c)).every((c) => inSet(c, i + 1, box.messages.length)));
        w(`* SEARCH ${hits.map((h) => h.key).join(" ")}`.trimEnd());
        return w(`${tag} OK done`);
      }
      case "UID FETCH": case "FETCH": {
        if (!box) return w(`${tag} BAD not selected`);
        const items = flat(args.slice(1)).map((s) => String(s));
        const up = items.map((s) => s.toUpperCase());
        const max = cmd === "UID FETCH" ? (box.messages.at(-1)?.uid ?? 0) : box.messages.length;
        box.messages.forEach((m, i) => {
          const key = cmd === "UID FETCH" ? m.uid : i + 1;
          if (!inSet(args[0], key, max)) return;
          const { headers, head, body } = splitMessage(m.raw);
          const parts = [`UID ${m.uid}`];
          const lits = [];
          if (up.includes("FLAGS")) parts.push(`FLAGS (${[...m.flags].join(" ")})`);
          if (up.includes("RFC822.SIZE")) parts.push(`RFC822.SIZE ${m.raw.length}`);
          if (up.includes("INTERNALDATE")) parts.push(`INTERNALDATE "01-Oct-2026 10:00:00 +0000"`);
          if (up.includes("ENVELOPE")) {
            parts.push(`ENVELOPE (${q(headers.date)} ${q(headers.subject)} ${addrList(headers.from)} ${addrList(headers.from)} ${addrList(headers.from)} ${addrList(headers.to)} NIL NIL ${q(headers["in-reply-to"])} ${q(headers["message-id"])})`);
          }
          if (up.includes("BODYSTRUCTURE")) {
            const ct = (headers["content-type"] || "text/plain").toLowerCase();
            const [type, sub] = ct.split(";")[0].trim().split("/");
            const enc = (headers["content-transfer-encoding"] || "7bit").toUpperCase();
            parts.push(`BODYSTRUCTURE (${q(type.toUpperCase())} ${q(sub.toUpperCase())} ("CHARSET" "utf-8") NIL NIL ${q(enc)} ${Buffer.byteLength(body)} ${body.split("\r\n").length} NIL NIL NIL NIL)`);
          }
          for (const it of items) {
            const sec = /^BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i.exec(it) || /^BODY\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i.exec(it);
            if (!sec) continue;
            if (/^BODY\[/i.test(it)) m.flags.add("\\Seen"); // non-PEEK sets \Seen
            let data;
            const section = sec[1].toUpperCase();
            if (section === "") data = m.raw;
            else if (section === "1" || section === "TEXT") data = Buffer.from(body, "latin1");
            else if (section.startsWith("HEADER.FIELDS")) {
              const want = /\(([^)]*)\)/.exec(section)?.[1].split(/\s+/).map((x) => x.toLowerCase()) ?? [];
              data = Buffer.from(head.split("\r\n").filter((l) => want.includes(l.split(":")[0].toLowerCase())).join("\r\n") + "\r\n\r\n", "latin1");
            } else data = Buffer.alloc(0);
            let label = `BODY[${sec[1]}]`;
            if (sec[2] !== undefined) {
              data = data.subarray(Number(sec[2]), Number(sec[2]) + Number(sec[3]));
              label += `<${sec[2]}>`;
            }
            lits.push({ label, data });
          }
          if (!lits.length) return w(`* ${i + 1} FETCH (${parts.join(" ")})`);
          conn.sock.write(`* ${i + 1} FETCH (${parts.join(" ")}`);
          for (const l of lits) {
            conn.sock.write(` ${l.label} {${l.data.length}}\r\n`);
            conn.sock.write(l.data);
          }
          conn.sock.write(`)\r\n`);
        });
        return w(`${tag} OK fetched`);
      }
      default:
        return w(`${tag} BAD unknown command ${cmd}`);
    }
  }

  expungeWhere(conn, box, pred, notify) {
    for (let i = box.messages.length - 1; i >= 0; i--) {
      const m = box.messages[i];
      if (m.flags.has("\\Deleted") && pred(m)) {
        box.messages.splice(i, 1);
        if (notify) conn.w(`* ${i + 1} EXPUNGE`);
      }
    }
  }
}

export const rawMsg = (subject, opts = {}) => {
  const body = opts.body ?? `body of ${subject}`;
  return (
    `Date: ${opts.date ?? "Thu, 01 Oct 2026 10:00:00 +0000"}\r\n` +
    `From: ${opts.from ?? "Alice <alice@example.com>"}\r\n` +
    `To: bob@example.com\r\n` +
    `Subject: ${subject}\r\n` +
    `Message-ID: <${subject.replace(/\W/g, "") || "x"}@example.com>\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: ${opts.contentType ?? "text/plain; charset=utf-8"}\r\n\r\n` +
    `${body}\r\n`
  );
};
