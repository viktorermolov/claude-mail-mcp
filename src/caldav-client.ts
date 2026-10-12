/**
 * Read-only CalDAV client (RFC 4791), written for iCloud calendars.
 *
 * Read-only by construction: the only HTTP methods this module can send
 * are PROPFIND and REPORT (see ReadMethod), and there is no code that
 * creates, changes or deletes calendar objects. Tests pin this with a
 * source scan.
 *
 * Calendar data comes from other people too (invitations), so it is
 * treated like mail: responses are size-capped, XML with a DOCTYPE is
 * refused (no entity expansion), and recurrence expansion is bounded.
 * Credentials are only ever sent to the configured origin or, for iCloud,
 * to other https hosts under the same parent domain (iCloud answers with
 * per-user hosts like p42-caldav.icloud.com); every redirect is checked.
 */

import { XMLParser } from "fast-xml-parser";
import ICAL from "ical.js";

export const CALDAV_LIMITS = {
  requestMs: 30_000,
  maxResponseBytes: 8 * 1024 * 1024,
  maxRedirects: 4,
  maxRangeDays: 366,
  /** Recurrence steps per event and per request (old daily series need thousands). */
  maxStepsPerEvent: 20_000,
  maxStepsPerRequest: 400_000,
  /** Home/calendar list cache. */
  discoveryTtlMs: 60 * 60 * 1000,
};

/** The only methods this client can send. */
type ReadMethod = "PROPFIND" | "REPORT";

export interface CalDavAuth {
  url: string;
  user: string;
  pass: string;
}

export interface CalendarInfo {
  /** The calendar collection's path on the server; pass it back as `calendar_id`. */
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  /** Component types the collection holds, e.g. ["VEVENT"] or ["VTODO"]. */
  components: string[];
}

export interface EventSummary {
  event_id: string;
  calendar_id: string;
  calendar: string;
  uid: string | null;
  summary: string | null;
  start: string;
  end: string | null;
  all_day: boolean;
  location: string | null;
  status: string | null;
  recurring: boolean;
  /** For an occurrence of a recurring event: its original start (pass to get_event). */
  recurrence_id: string | null;
  description: string | null;
}

export interface EventDetail extends EventSummary {
  url: string | null;
  organizer: string | null;
  attendees: Array<{ name: string | null; email: string | null; status: string | null; role: string | null }>;
  rrule: string | null;
  exceptions: string[];
  timezone: string;
}

export class CalDavError extends Error {}

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ["response", "propstat", "comp", "href"].includes(name),
});

type Xml = Record<string, unknown>;

interface DavResponse {
  href: string;
  props: Xml;
}

export class CalDavClient {
  private readonly base: URL;
  private readonly authHeader: string;
  private discovery: { at: number; home: URL; calendars: CalendarInfo[] } | null = null;

  constructor(auth: CalDavAuth) {
    this.base = new URL(auth.url);
    if (this.base.protocol !== "https:" && !isLoopback(this.base)) {
      throw new CalDavError("CalDAV URL must use https.");
    }
    this.authHeader = "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64");
  }

  async listCalendars(signal?: AbortSignal): Promise<CalendarInfo[]> {
    return (await this.discover(signal)).calendars;
  }

  /**
   * Events overlapping [from, to) in the given calendars (default: all
   * calendars that hold events), recurring series expanded.
   */
  async listEvents(
    opts: { from: Date; to: Date; calendarIds?: string[]; query?: string; timezone: string; limit: number },
    signal?: AbortSignal
  ): Promise<{ events: EventSummary[]; total: number; expansionCapped: boolean }> {
    const { calendars } = await this.discover(signal);
    const selected = this.pickCalendars(calendars, opts.calendarIds).filter((c) => c.components.includes("VEVENT"));
    const budget = { steps: CALDAV_LIMITS.maxStepsPerRequest, capped: false };
    const out: EventSummary[] = [];
    const needle = opts.query?.toLowerCase();
    for (const cal of selected) {
      const body =
        `<c:calendar-query xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop><c:calendar-data/></d:prop>` +
        `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
        `<c:time-range start="${icalUtc(opts.from)}" end="${icalUtc(opts.to)}"/>` +
        `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
      const responses = await this.multistatus("REPORT", new URL(cal.id, this.discovery!.home), "1", body, signal);
      for (const r of responses) {
        const data = textOf(r.props["calendar-data"]);
        if (!data) continue;
        expand(data, opts.from, opts.to, opts.timezone, budget, (occ) => {
          const summary = toSummary(occ, r.href, cal, opts.timezone, 300);
          if (!needle || matches(summary, occ.description, needle)) out.push(summary);
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    out.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return { events: out.slice(0, opts.limit), total: out.length, expansionCapped: budget.capped };
  }

  /** One calendar object by its event_id, with full description and attendees. */
  async getEvent(eventId: string, recurrenceId: string | undefined, timezone: string, signal?: AbortSignal): Promise<EventDetail> {
    const { calendars, home } = await this.discover(signal);
    const cal = calendars.find((c) => eventId.startsWith(c.id) && eventId.length > c.id.length);
    if (!cal || !/\.ics$/i.test(eventId) || eventId.includes("..")) {
      throw new CalDavError(`Unknown event_id. Use list_events to get one.`);
    }
    const body =
      `<c:calendar-multiget xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop><c:calendar-data/></d:prop>` +
      `<d:href>${escapeXml(eventId)}</d:href></c:calendar-multiget>`;
    const responses = await this.multistatus("REPORT", new URL(cal.id, home), "1", body, signal);
    const data = responses.map((r) => textOf(r.props["calendar-data"])).find(Boolean);
    if (!data) throw new CalDavError("Event not found (it may have been deleted).");
    return detail(data, eventId, cal, recurrenceId, timezone);
  }

  // ---- discovery ---------------------------------------------------------------

  private async discover(signal?: AbortSignal): Promise<{ home: URL; calendars: CalendarInfo[] }> {
    if (this.discovery && Date.now() - this.discovery.at < CALDAV_LIMITS.discoveryTtlMs) return this.discovery;
    const principalRes = await this.multistatus(
      "PROPFIND",
      this.base,
      "0",
      `<d:propfind xmlns:d="${DAV}"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
      signal
    );
    const principal = hrefIn(principalRes[0]?.props["current-user-principal"]);
    if (!principal) throw new CalDavError("CalDAV server did not report the user's principal.");
    const homeRes = await this.multistatus(
      "PROPFIND",
      new URL(principal, this.base),
      "0",
      `<d:propfind xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
      signal
    );
    const homeHref = hrefIn(homeRes[0]?.props["calendar-home-set"]);
    if (!homeHref) throw new CalDavError("CalDAV server did not report a calendar home.");
    const home = new URL(homeHref, this.base);
    this.assertTrusted(home);
    const list = await this.multistatus(
      "PROPFIND",
      home,
      "1",
      `<d:propfind xmlns:d="${DAV}" xmlns:c="${CALDAV}" xmlns:a="http://apple.com/ns/ical/"><d:prop>` +
        `<d:resourcetype/><d:displayname/><c:calendar-description/><c:supported-calendar-component-set/><a:calendar-color/>` +
        `</d:prop></d:propfind>`,
      signal
    );
    const calendars: CalendarInfo[] = [];
    for (const r of list) {
      const type = r.props.resourcetype;
      if (!type || typeof type !== "object" || !("calendar" in (type as Xml))) continue;
      const set = (r.props["supported-calendar-component-set"] as Xml | undefined)?.comp;
      const components = Array.isArray(set)
        ? set.map((c) => String((c as Xml)["@name"] ?? "").toUpperCase()).filter(Boolean)
        : [];
      calendars.push({
        id: new URL(r.href, home).pathname,
        name: decodeXml(textOf(r.props.displayname)) || "(unnamed)",
        description: decodeXml(textOf(r.props["calendar-description"])) || null,
        color: decodeXml(textOf(r.props["calendar-color"])) || null,
        components,
      });
    }
    this.discovery = { at: Date.now(), home, calendars };
    return this.discovery;
  }

  private pickCalendars(all: CalendarInfo[], ids?: string[]): CalendarInfo[] {
    if (!ids || ids.length === 0) return all;
    return ids.map((id) => {
      const hit = all.find((c) => c.id === id || c.name === id);
      if (!hit) throw new CalDavError(`Unknown calendar "${id}". Use list_calendars for the ids.`);
      return hit;
    });
  }

  // ---- HTTP --------------------------------------------------------------------

  private async multistatus(method: ReadMethod, url: URL, depth: "0" | "1", body: string, signal?: AbortSignal): Promise<DavResponse[]> {
    const text = await this.request(method, url, depth, body, signal);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new CalDavError("CalDAV response contains a DOCTYPE; refused.");
    const doc = parser.parse(text) as Xml;
    const ms = doc.multistatus as Xml | undefined;
    const responses = (ms?.response as Xml[] | undefined) ?? [];
    return responses.map((r) => {
      const props: Xml = {};
      for (const ps of (r.propstat as Xml[] | undefined) ?? []) {
        if (!/\s200\s/.test(` ${textOf(ps.status)} `)) continue;
        Object.assign(props, (ps.prop as Xml | undefined) ?? {});
      }
      return { href: decodeXml(textOf((r.href as unknown[] | undefined)?.[0])), props };
    });
  }

  private async request(method: ReadMethod, url: URL, depth: "0" | "1", body: string, signal?: AbortSignal): Promise<string> {
    let target = url;
    for (let hop = 0; hop <= CALDAV_LIMITS.maxRedirects; hop++) {
      this.assertTrusted(target);
      const timeout = AbortSignal.timeout(CALDAV_LIMITS.requestMs);
      const res = await fetch(target, {
        method,
        redirect: "manual",
        headers: {
          authorization: this.authHeader,
          depth,
          "content-type": 'application/xml; charset="utf-8"',
        },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) throw new CalDavError(`CalDAV redirect without a location (HTTP ${res.status}).`);
        target = new URL(location, target);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        throw new CalDavError("CalDAV login was rejected (check the app-specific password).");
      }
      if (res.status !== 207 && res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        throw new CalDavError(`CalDAV ${method} failed: HTTP ${res.status}.`);
      }
      return readCapped(res, CALDAV_LIMITS.maxResponseBytes);
    }
    throw new CalDavError("Too many CalDAV redirects.");
  }

  /** Credentials go only to the configured origin or https hosts under its parent domain. */
  private assertTrusted(url: URL): void {
    if (url.origin === this.base.origin) return;
    const parent = this.base.hostname.split(".").slice(-2).join(".");
    const ok = url.protocol === "https:" && url.username === "" && (url.hostname === parent || url.hostname.endsWith(`.${parent}`));
    if (!ok) throw new CalDavError(`Refusing to send calendar credentials to ${url.host}.`);
  }
}

// ---- helpers -------------------------------------------------------------------

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new CalDavError(`CalDAV response larger than ${Math.round(max / 1024 / 1024)} MB; narrow the date range.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function textOf(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "#text" in (v as Xml)) return textOf((v as Xml)["#text"]);
  return "";
}

function hrefIn(v: unknown): string | null {
  const hrefs = v && typeof v === "object" ? (v as Xml).href : undefined;
  const first = Array.isArray(hrefs) ? textOf(hrefs[0]) : textOf(hrefs);
  return first ? decodeXml(first) : null;
}

/** The predefined XML entities and character references (DOCTYPE entities are refused earlier). */
export function decodeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
    }
    const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function icalUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ---- time zones ------------------------------------------------------------------

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(instant: number, tz: string): number[] {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month), Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)];
}

/** Offset of `tz` from UTC at `instant`, in ms. */
function offsetAt(instant: number, tz: string): number {
  const [y, mo, d, h, mi, s] = partsIn(instant, tz);
  return Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(instant / 1000) * 1000;
}

/** Wall-clock time in `tz` → instant. */
export function zonedToInstant(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let instant = guess - offsetAt(guess, tz);
  instant = guess - offsetAt(instant, tz);
  return new Date(instant);
}

/** ISO 8601 with the offset of `tz`, e.g. 2026-10-12T09:30:00-07:00. */
export function isoIn(date: Date, tz: string): string {
  const t = date.getTime();
  const [y, mo, d, h, mi, s] = partsIn(t, tz);
  const off = Math.round(offsetAt(t, tz) / 60000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

// ---- iCalendar ---------------------------------------------------------------------

interface Occurrence {
  item: ICAL.Event;
  start: ICAL.Time;
  end: ICAL.Time | null;
  startInstant: Date;
  endInstant: Date;
  recurring: boolean;
  recurrenceId: ICAL.Time | null;
  description: string | null;
}

/**
 * Instant of an ICAL.Time. ical.js resolves a TZID against the VTIMEZONE in
 * the same calendar object (never a global registry, so one invitation's
 * zones can't affect another's). A TZID without a definition is read as an
 * IANA zone; floating times and dates are read in `tz`.
 */
function instantOf(t: ICAL.Time, tz: string): Date {
  if (!t.isDate) {
    const zone = t.zone as { tzid?: string } | null | undefined;
    if (zone?.tzid && zone.tzid !== "floating") return t.toJSDate();
    const declared = (t as unknown as { timezone?: string }).timezone;
    if (declared && isValidTimeZone(declared)) {
      return zonedToInstant(t.year, t.month, t.day, t.hour, t.minute, t.second, declared);
    }
    return zonedToInstant(t.year, t.month, t.day, t.hour, t.minute, t.second, tz);
  }
  return zonedToInstant(t.year, t.month, t.day, 0, 0, 0, tz);
}

/** Parse one calendar object and run `fn` on it; a malformed object yields `fallback`. */
function withCalendar<T>(data: string, fallback: T, fn: (comp: ICAL.Component) => T): T {
  let comp: ICAL.Component;
  try {
    comp = new ICAL.Component(ICAL.parse(decodeXml(data)));
  } catch {
    return fallback; // one malformed object never breaks the listing
  }
  return fn(comp);
}

function masterAndExceptions(comp: ICAL.Component): Array<{ master: ICAL.Event; exceptions: ICAL.Event[] }> {
  const vevents = comp.getAllSubcomponents("vevent");
  const masters = vevents.filter((v) => !v.hasProperty("recurrence-id")).map((v) => new ICAL.Event(v));
  const out = masters.map((master) => ({ master, exceptions: [] as ICAL.Event[] }));
  for (const v of vevents.filter((x) => x.hasProperty("recurrence-id"))) {
    const ex = new ICAL.Event(v);
    const owner = out.find((o) => o.master.uid === ex.uid);
    if (owner) {
      owner.master.relateException(ex);
      owner.exceptions.push(ex);
    } else {
      out.push({ master: ex, exceptions: [] }); // an orphan override: show it as a single event
    }
  }
  return out;
}

function expand(data: string, from: Date, to: Date, tz: string, budget: { steps: number; capped: boolean }, emit: (o: Occurrence) => void): void {
  withCalendar(data, undefined, (comp) => expandParsed(comp, from, to, tz, budget, emit));
}

function expandParsed(
  comp: ICAL.Component,
  from: Date,
  to: Date,
  tz: string,
  budget: { steps: number; capped: boolean },
  emit: (o: Occurrence) => void
): void {
  const out = { push: emit };
  for (const { master } of masterAndExceptions(comp)) {
    try {
      if (!master.startDate) continue;
      if (!master.isRecurring()) {
        const occ = occurrence(master, master.startDate, master.endDate, tz, false, null);
        if (occ.startInstant < to && occ.endInstant > from) out.push(occ);
        continue;
      }
      const it = master.iterator();
      let steps = 0;
      for (let next = it.next(); next; next = it.next()) {
        if (++steps > CALDAV_LIMITS.maxStepsPerEvent || --budget.steps < 0) {
          budget.capped = true;
          break;
        }
        const d = master.getOccurrenceDetails(next);
        const occ = occurrence(d.item, d.startDate, d.endDate, tz, true, d.recurrenceId);
        if (instantOf(d.recurrenceId, tz) >= to && occ.startInstant >= to) break;
        if (occ.startInstant < to && occ.endInstant > from) out.push(occ);
      }
    } catch {
      // skip a malformed event
    }
  }
}

function occurrence(
  item: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time | null | undefined,
  tz: string,
  recurring: boolean,
  recurrenceId: ICAL.Time | null
): Occurrence {
  const startInstant = instantOf(start, tz);
  // A zero-length event still "overlaps" the instant it happens at.
  const endInstant = end ? instantOf(end, tz) : new Date(startInstant.getTime() + (start.isDate ? 86_400_000 : 1));
  return {
    item,
    start,
    end: end ?? null,
    startInstant,
    endInstant: endInstant > startInstant ? endInstant : new Date(startInstant.getTime() + 1),
    recurring,
    recurrenceId,
    description: str(item.description),
  };
}

function fmt(t: ICAL.Time, instant: Date, tz: string): string {
  return t.isDate ? t.toString().slice(0, 10) : isoIn(instant, tz);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function cut(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}

function toSummary(o: Occurrence, href: string, cal: CalendarInfo, tz: string, descMax: number): EventSummary {
  return {
    event_id: href,
    calendar_id: cal.id,
    calendar: cal.name,
    uid: o.item.uid ?? null,
    summary: str(o.item.summary),
    start: fmt(o.start, o.startInstant, tz),
    end: o.end ? fmt(o.end, o.endInstant, tz) : null,
    all_day: o.start.isDate,
    location: str(o.item.location),
    status: str(o.item.component.getFirstPropertyValue("status")),
    recurring: o.recurring,
    recurrence_id: o.recurrenceId ? fmt(o.recurrenceId, instantOf(o.recurrenceId, tz), tz) : null,
    description: cut(o.description, descMax),
  };
}

function sortKey(e: EventSummary): string {
  // All-day dates sort before timed events of the same day.
  return e.all_day ? `${e.start}T00:00:00` : new Date(e.start).toISOString();
}

function matches(e: EventSummary, description: string | null, needle: string): boolean {
  return [e.summary, e.location, description].some((v) => v?.toLowerCase().includes(needle));
}

function person(p: ICAL.Property | null): { name: string | null; email: string | null; status: string | null; role: string | null } | null {
  if (!p) return null;
  const value = String(p.getFirstValue() ?? "");
  const email = /^mailto:/i.test(value) ? value.slice(7) : null;
  const cn = p.getParameter("cn");
  const status = p.getParameter("partstat");
  const role = p.getParameter("role");
  return {
    name: typeof cn === "string" ? cn : null,
    email,
    status: typeof status === "string" ? status : null,
    role: typeof role === "string" ? role : null,
  };
}

function detail(data: string, eventId: string, cal: CalendarInfo, recurrenceId: string | undefined, tz: string): EventDetail {
  const result = withCalendar<EventDetail | null>(data, null, (comp) => detailParsed(comp, eventId, cal, recurrenceId, tz));
  if (!result) throw new CalDavError("The event could not be parsed.");
  return result;
}

function detailParsed(comp: ICAL.Component, eventId: string, cal: CalendarInfo, recurrenceId: string | undefined, tz: string): EventDetail | null {
  const group = masterAndExceptions(comp)[0];
  if (!group) return null;
  let item = group.master;
  if (recurrenceId) {
    const want = new Date(recurrenceId).getTime();
    const ex = group.exceptions.find(
      (e) =>
        Math.abs(instantOf(e.recurrenceId, tz).getTime() - want) < 1000 ||
        (e.recurrenceId.isDate && e.recurrenceId.toString().slice(0, 10) === recurrenceId.slice(0, 10))
    );
    if (ex) item = ex;
  }
  const start = item.startDate;
  const end = item.endDate;
  const startInstant = instantOf(start, tz);
  const occ: Occurrence = {
    item,
    start,
    end: end ?? null,
    startInstant,
    endInstant: end ? instantOf(end, tz) : startInstant,
    recurring: group.master.isRecurring(),
    recurrenceId: item.isRecurrenceException() ? item.recurrenceId : null,
    description: str(item.description),
  };
  const base = toSummary(occ, eventId, cal, tz, 20_000);
  const rrule = group.master.component.getFirstPropertyValue("rrule");
  const attendees = item.component
    .getAllProperties("attendee")
    .slice(0, 100)
    .map((p) => person(p)!)
    .filter(Boolean);
  const url = item.component.getFirstPropertyValue("url");
  return {
    ...base,
    url: typeof url === "string" ? url : null,
    organizer: (() => {
      const o = person(item.component.getFirstProperty("organizer"));
      return o ? (o.name && o.email ? `${o.name} <${o.email}>` : (o.email ?? o.name)) : null;
    })(),
    attendees,
    rrule: rrule ? String(rrule.toString()) : null,
    exceptions: group.exceptions.map((e) => fmt(e.recurrenceId, instantOf(e.recurrenceId, tz), tz)).slice(0, 200),
    timezone: tz,
  };
}

/** Start of the calendar day `ymd` (YYYY-MM-DD) in `tz`. */
export function dayStart(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedToInstant(y, m, d, 0, 0, 0, tz);
}

/** Today's date (YYYY-MM-DD) in `tz`. */
export function todayIn(tz: string, now = Date.now()): string {
  const [y, m, d] = partsIn(now, tz);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
