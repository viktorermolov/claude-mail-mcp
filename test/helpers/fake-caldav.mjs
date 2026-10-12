// Minimal fake CalDAV server (iCloud-shaped discovery) for tests. Records
// every request's method, path and whether it carried the credentials.
import http from "node:http";

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">${body}</d:multistatus>`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ok = (href, props) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

export class FakeCalDav {
  constructor({ user = "u", pass = "p", objects = {}, hooks = {} } = {}) {
    this.auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    this.objects = objects; // { "/123/calendars/home/": [{ name: "a.ics", ics }] }
    this.hooks = hooks;
    this.log = [];
  }

  listen(host = "127.0.0.1") {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => this.handle(req, res, body));
    });
    return new Promise((r) => this.server.listen(0, host, () => {
      this.url = `http://${host}:${this.server.address().port}`;
      r(this.url);
    }));
  }

  close() {
    return new Promise((r) => this.server.close(() => r()));
  }

  handle(req, res, body) {
    this.log.push({ method: req.method, path: req.url, authed: req.headers.authorization === this.auth, depth: req.headers.depth });
    if (this.hooks.onRequest && this.hooks.onRequest(req, res, body, this) === "handled") return;
    if (req.headers.authorization !== this.auth) { res.statusCode = 401; return res.end(); }
    const send = (s) => { res.statusCode = 207; res.setHeader("content-type", "application/xml; charset=utf-8"); res.end(s); };
    if (req.method === "PROPFIND" && req.url === "/") {
      return send(xml(ok("/", `<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>`)));
    }
    if (req.method === "PROPFIND" && req.url === "/123/principal/") {
      return send(xml(ok("/123/principal/", `<c:calendar-home-set><d:href>${this.url}/123/calendars/</d:href></c:calendar-home-set>`)));
    }
    if (req.method === "PROPFIND" && req.url === "/123/calendars/") {
      return send(xml(
        ok("/123/calendars/", `<d:resourcetype><d:collection/></d:resourcetype>`) +
        ok("/123/calendars/home/", `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Home &amp; Family</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><a:calendar-color>#FF2968FF</a:calendar-color>`) +
        ok("/123/calendars/tasks/", `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Reminders</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>`) +
        ok("/123/calendars/inbox/", `<d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype>`)
      ));
    }
    if (req.method === "REPORT" && this.objects[req.url]) {
      let list = this.objects[req.url];
      if (body.includes("calendar-multiget")) {
        const href = /<d:href>([^<]+)<\/d:href>/.exec(body)?.[1];
        list = list.filter((o) => req.url + o.name === href);
      }
      return send(xml(list.map((o) => ok(req.url + o.name, `<c:calendar-data>${esc(o.ics)}</c:calendar-data>`)).join("")));
    }
    res.statusCode = 404;
    res.end();
  }
}

export const LA_TZ = [
  "BEGIN:VTIMEZONE", "TZID:America/Los_Angeles",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0800", "TZOFFSETTO:-0700", "DTSTART:20070311T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "TZNAME:PDT", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0700", "TZOFFSETTO:-0800", "DTSTART:20071104T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZNAME:PST", "END:STANDARD",
  "END:VTIMEZONE",
];

export const ics = (...lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...lines.flat(), "END:VCALENDAR", ""].join("\r\n");
