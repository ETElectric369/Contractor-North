// Shared between the chat route (server) and the assistant client. The chat normally
// streams plain text; when the agent proposes a CONFIRM-gated action (e.g. record a cost),
// the server appends this marker followed by a JSON proposal as the LAST thing in the
// stream. The client splits on the marker: everything before is the spoken/printed reply,
// everything after is the proposal to confirm. ␞ (U+241E) won't occur in normal prose.
export const CONFIRM_MARKER = "␞CN_CONFIRM␞";

/** THE ONE CHARACTER EVERY MARKER IS BUILT ON (U+241E). Model text never carries it — the route
 *  strips it from every delta, so no marker can be assembled across the chunks a stream cuts a
 *  reply into (audit v1120, class 2: a per-chunk match of whole marker strings let a split marker
 *  through) — and a directive's JSON never carries it inside a string, so a model-authored title
 *  cannot close one block and open another. */
export const stripMarkerChar = (s: string): string => s.replace(/\u241E/g, "");
/** A directive as the server emits it: the markers around JSON that cannot contain a marker. */
export const envelope = (open: string, payload: unknown, close = ""): string => open + stripMarkerChar(JSON.stringify(payload ?? null)) + close;

/** The proposal the user must approve before the action actually runs. */
export type AgentConfirm = {
  /** Canonical registry action name, e.g. "bill.create". */
  name: string;
  /** The exact validated input the agent proposed. */
  input: Record<string, unknown>;
  /** Human read-back, e.g. "Add a $40.00 cost from Home Depot — say yes to confirm." */
  prompt: string;
};

// A second client directive: open Maps (navigate / find a place). Emitted as the last
// stream chunk, same split rule as the confirm marker. The agent decides search vs
// directions; the client opens the URL.
export const OPEN_MARKER = "␞CN_OPEN␞";

export type AgentOpen = {
  /** Maps URL to open. */
  url: string;
  /** What we're opening, for the read-back, e.g. "gas station". */
  label: string;
};

// A BIDIRECTIONAL client directive: open the on-screen CONTACT PICKER so the user can search +
// physically tap a contact mid-conversation (e.g. while building an estimate). Emitted as the last
// stream chunk (same split rule as OPEN/CONFIRM). Unlike OPEN, the result comes BACK: after the user
// picks, the client sends their choice as the next message so the agent resumes — the "say the name,
// pick it on screen, keep building" flow.
export const PICK_MARKER = "␞CN_PICK␞";

export type AgentPick = {
  /** What to pick — a contact (customer / subcontractor) for now. */
  kind: "contact";
  /** Optional search term to pre-fill the picker, e.g. "Marla". */
  search?: string;
  /** Optional type filter. */
  type?: "residential" | "commercial" | "industrial" | "subcontractor";
  /** Short read-back, e.g. "pick the contact to add". */
  label?: string;
};

// Transient TOOL-STATUS while the agent works (so a silent tool call doesn't feel dead). Emitted
// inline as the agent enters a tool batch; the client shows the latest as a "Searching…" pill while
// streaming and clears it when text resumes. Delimited so it's strippable from the visible text.
export const STATUS_OPEN = "␞CN_STATUS␞";
export const STATUS_CLOSE = "␞/CN_STATUS␞";

// A LIVE quote draft the agent builds as you talk — emitted MID-stream (delimited by an
// open/close marker so the client can extract complete blocks while text keeps streaming),
// and re-emitted each time a line is added/changed, so the preview fills in line-by-line.
export const DRAFT_OPEN = "␞CN_DRAFT␞";
export const DRAFT_CLOSE = "␞/CN_DRAFT␞";

export type AgentDraftItem = {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
};

export type AgentDraft = {
  kind: "quote";
  /** Display name; resolve customer_id via list_customers when known (null = unattached). */
  customer_name?: string | null;
  customer_id?: string | null;
  job_id?: string | null;
  title?: string;
  /** Fraction, e.g. 0.0825 for 8.25%. */
  tax_rate?: number;
  items: AgentDraftItem[];
  /** "building" while gathering, "ready" once read back + good to save. */
  status?: "building" | "ready";
};

// The DRIVER HUD CARD — the "windshield". When the user asks Nort to pull up / show an
// entity (a job, estimate, invoice, customer, or the day), the agent calls show_card with
// the KEY glanceable facts and the client fills the N-Box with one big, driver-safe card
// instead of a wall of text. Emitted as a delimited block, same mid-stream extract rule as
// DRAFT (the client keeps the LAST complete block).
export const HUD_OPEN = "␞CN_HUD␞";
export const HUD_CLOSE = "␞/CN_HUD␞";

// WHAT NORT STILL HOLDS, at the end of every turn (0394): the server's own count after any
// hand-over, so the phone's ring and the next greeting never say "eight updates" about things
// just read out. Erik, the first night: "he asked if i want the updates now i said sure, it
// repeated, then didnt remember the next time and the light was still blinking and it started
// over" — the phone's copy was only ever refreshed by the Bell's minute poll. Delimited like HUD;
// the client keeps the LAST complete block and strips it from the text.
export const HOLDING_OPEN = "␞CN_HOLDING␞";
export const HOLDING_CLOSE = "␞/CN_HOLDING␞";

export type HudFact = {
  /** Short label, e.g. "gate code", "balance due", "hours today". */
  label: string;
  /** The value, already formatted for the eye, e.g. "4412", "$7,350", "6.5h". */
  value: string;
};

/** One row of a projected LIST block — an estimate line, an appointment, a duplicate
 *  contact, a job in a set. label on the left, value on the right, an optional dimmer sub. */
export type HudRow = {
  label: string;
  /** Right-aligned value, e.g. "$3,600", "8:00a", "(530) 555-0133". */
  value?: string | null;
  /** A quieter second line under the label, e.g. "24 hr × $150", "Tue Jul 15". */
  sub?: string | null;
  /** Optional deep link so a parked tap opens that row's record. */
  href?: string | null;
};

/**
 * The glass Nort projects — a COMPOSABLE card, not a fixed shape. Nort fills only the
 * blocks it needs and they stack in order: eyebrow → title → address → scope → facts
 * tiles → a titled ROWS list (line items, a day's appointments, duplicate contacts side
 * by side, a set of jobs) → an optional total → the one look-ahead line. Think hologram
 * projector: same frame, any content.
 */
export type AgentHudCard = {
  kind: "job" | "estimate" | "invoice" | "customer" | "schedule" | "task" | "list";
  /** The headline — the customer / entity name (or a list heading like "3 duplicate Millers"). */
  title: string;
  /** A short context line, e.g. "on the clock · J-012" or "draft estimate". */
  eyebrow?: string | null;
  /** A one-line scope / summary. */
  scope?: string | null;
  /** Street address — the card turns it into one tap to Maps. */
  address?: string | null;
  /** Up to ~4 big glanceable tiles (gate code, balance due, hours, …). */
  facts?: HudFact[];
  /** A projected LIST — estimate line items, a day's appointments, duplicate contacts, jobs. */
  rows?: HudRow[];
  /** Heading above the rows, e.g. "Line items", "Today's stops", "3 versions on file". */
  rowsTitle?: string | null;
  /** A bold total row under the list, e.g. { label: "Total", value: "$7,350" }. */
  total?: HudFact | null;
  /** The one look-ahead line, e.g. "next: 8:00 at the Lim's, 6 min away". */
  next?: string | null;
  /** Deep link to the full screen, so tapping the card opens it when parked. */
  href?: string | null;
  /** true = clear the card off the glass. */
  cleared?: boolean;
};

/**
 * The ONLY kind of link a HUD card may carry: a same-app, absolute, RELATIVE path.
 *
 * A card's `href` and its `rows[].href` are MODEL-authored, and the model routinely reads
 * customer-controlled text (notes, inquiry messages). Rendered as a next/link inside the PWA —
 * where standalone display mode shows no address bar — an off-origin URL would be an attacker's
 * page one tap away, dressed as the app. So href is never trusted: only "/..." internal paths
 * pass; absolute URLs ("https://…"), protocol-relative ("//…"), and backslash tricks ("/\…")
 * all return null and the consumer falls back to plain text (no link). Same predicate as the
 * ?next= open-redirect guard (safeNextPath); duplicated here so this module stays dependency-free
 * and usable from both the server route and the client card renderer.
 */
export function safeInternalHref(raw: unknown): string | null {
  const p = typeof raw === "string" ? raw.trim() : "";
  // A TAB OR A NEWLINE IS AN ESCAPE (skeptic #6, item 6): the URL parser strips ASCII tab, CR and LF
  // before it reads a path, so "/\t/evil.com" is "//evil.com" — protocol-relative — by the time the
  // router sees it. No control character and no whitespace survives here.
  return p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") && !/[\s\u0000-\u001f\u007f]/.test(p) ? p.slice(0, 512) : null;
}

/**
 * Server-side clamp for a show_card payload before it reaches the client: strip every href that
 * isn't a safe internal path so a compromised card can never carry an off-origin link to the
 * windshield. Structure-preserving — every other field passes through untouched (they render as
 * plain text, never as a navigation target). The client card renderer applies safeInternalHref
 * again at the render boundary (defense in depth), so any future consumer inherits the guard too.
 */
export function sanitizeHudCard(input: unknown): Partial<AgentHudCard> {
  const c = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...c };
  const href = safeInternalHref(c.href);
  if (href) out.href = href;
  else delete out.href;
  if (Array.isArray(c.rows)) {
    out.rows = c.rows.map((r) => {
      const row = (r ?? {}) as Record<string, unknown>;
      const rh = safeInternalHref(row.href);
      const cleaned = { ...row };
      if (rh) cleaned.href = rh;
      else delete cleaned.href;
      return cleaned;
    });
  }
  return out as Partial<AgentHudCard>;
}

// NORT DRIVES THE SCREEN (field feedback 10-13, item 6; Erik 2026-10-13: "compare how you have
// access to my entire computer and can connect to anywhere you need to in order to complete a
// task, thats what we are looking for with Nort"). The first rung is the BODY: a client directive
// that takes the person to a screen, scrolls to a named spot on it and rings it, opens the avatar
// menu, or parks Nort's own box as a bar so the screen is theirs while he keeps talking. Emitted
// MID-stream like HUD (delimited; the agent keeps talking after it moves the screen) — but unlike
// HUD every complete block is PERFORMED ONCE, in order: "go to the job, then its Costs tab" is
// two blocks, not a last-wins card. It only moves and points: fill-vs-execute holds, nothing is
// saved, and the write freeze is untouched.
export const SCREEN_OPEN = "␞CN_SCREEN␞";
export const SCREEN_CLOSE = "␞/CN_SCREEN␞";

export type AgentScreen = {
  /** A same-app path with its query, e.g. "/jobs/<id>?tab=costs"; omitted = stay on this screen. */
  path?: string | null;
  /** A named spot on the screen to scroll to and ring: a `data-tour` name or an element id. */
  anchor?: string | null;
  /** A menu to open first: the avatar menu behind the person's initials. */
  menu?: "account" | null;
  /** Nort's own box: "bar" parks it as a slim bar (he keeps talking), "open" brings it back. */
  box?: "bar" | "open" | null;
  /** What he is showing, in a few words — the parked bar reads it, e.g. "the Costs tab". */
  label?: string | null;
  /** TYPE INTO A BOX (rung 2): the door's name and the words (or the number, as said) to put in it. */
  fill?: { door: string; value: string } | null;
  /** ADD A ROW through an add-row door (a measurement): the door's name and its named fields. */
  add?: { door: string; fields: Record<string, string> } | null;
};

/** A fill's value: a note can be long, and keeps its line breaks; every other control char goes. */
export const FILL_VALUE_MAX = 2000;
/** An add-row door's fields: a few short named strings (label / value / unit). */
export const ADD_FIELDS_MAX = 8;
export const ADD_FIELD_MAX = 200;
export const ADD_KEY_RE = /^[a-z][a-z_]{0,19}$/;

/** Plain text for a box: control characters out, line breaks kept, capped — never "fixed" further. */
export function fillText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, max).trim();
  return t ? t : null;
}

/** A spot's name: the same alphabet `data-tour` and element ids use here; never a selector. */
export const SCREEN_ANCHOR_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

/**
 * THE SCREENS A DRIVE MAY LAND ON — the first path segment, pinned to lib/nort/screens by a test
 * (kept here so this module stays dependency-free). An internal path is not enough: /api/google/
 * connect bounces to Google, /login leaves the app shell and kills the chat, and a query key like
 * ?debrief=1 opens a door of its own. So a drive is a KNOWN screen, an optional record id, and
 * only the query keys the pages read.
 */
export const SCREEN_ROOTS = [
  "planner", "schedule", "timeclock", "jobs", "quotes", "billing", "bills", "crm", "leads", "inspections",
  "appointments", "settings", "timecards", "price-list", "analytics", "reconcile", "team",
] as const;
/** The office's screens: a tech's drive there is refused (and the model is told), never a dead page. */
export const SCREEN_ROOTS_STAFF_ONLY = new Set<string>([
  "schedule", "quotes", "billing", "bills", "crm", "leads", "inspections", "timecards", "price-list", "analytics", "reconcile", "team",
]);
/** The query keys the pages read (tabs.tsx ?tab=, schedule view/date, planner view/week, …). */
export const SCREEN_QUERY_KEYS = new Set<string>(["tab", "view", "date", "week", "status", "q", "open", "focus", "task", "type", "sort", "due"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A drive's path, or null: internal (safeInternalHref), a known screen root, at most one more
 * segment (a record's UUID, or "new" for a builder), and only the pages' own query keys with plain
 * values — returned canonical, so what the phone pushes is exactly what passed.
 */
export function screenPath(raw: unknown, isStaff = true): string | null {
  const p = safeInternalHref(raw);
  if (!p) return null;
  let u: URL;
  try {
    u = new URL(p, "http://x.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "http://x.invalid") return null;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 1 || segs.length > 2) return null;
  const root = segs[0].toLowerCase();
  if (!(SCREEN_ROOTS as readonly string[]).includes(root)) return null;
  if (!isStaff && SCREEN_ROOTS_STAFF_ONLY.has(root)) return null;
  if (segs.length === 2 && !UUID_RE.test(segs[1]) && segs[1] !== "new") return null;
  segs[0] = root;
  const q = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (!SCREEN_QUERY_KEYS.has(k)) return null;
    const val = v.trim().slice(0, 80);
    if (/[\u0000-\u001f\u007f<>"'`]/.test(val)) return null;
    q.set(k, val);
  }
  const qs = q.toString();
  return `/${segs.join("/")}${qs ? `?${qs}` : ""}`;
}

/**
 * Server-side clamp for a show_screen payload before it reaches the client. The path is
 * model-authored and the model reads customer-controlled text, so it passes the same internal-only
 * predicate a HUD href does (safeInternalHref); an anchor is a bare name (a selector would be an
 * injection surface the moment one is interpolated into querySelector); the enums are closed; the
 * label is text. Anything else is dropped, never "fixed".
 */
export function sanitizeScreen(input: unknown, opts: { isStaff?: boolean; voice?: boolean } = {}): AgentScreen {
  const c = (input ?? {}) as Record<string, unknown>;
  const out: AgentScreen = {};
  const path = screenPath(c.path, opts.isStaff !== false);
  if (path) out.path = path;
  const anchor = typeof c.anchor === "string" ? c.anchor.trim() : "";
  if (SCREEN_ANCHOR_RE.test(anchor)) out.anchor = anchor;
  if (c.menu === "account") out.menu = "account";
  // Parking the box is a VOICE move: by text the reply and the input live in it, so a bar would hide
  // the conversation he is having (skeptic #6). opts.voice unset = the client re-clamp: keep it.
  if ((c.box === "bar" && opts.voice !== false) || c.box === "open") out.box = c.box;
  const label = typeof c.label === "string" ? c.label.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (label) out.label = label;
  // TYPING FOR THEM (rung 2): a door is a bare name like an anchor; the value is text (a number is
  // parsed by the door itself, so "2.5" and "two" are the door's to accept or refuse in words).
  const fill = c.fill as Record<string, unknown> | undefined;
  if (fill && typeof fill === "object") {
    const door = typeof fill.door === "string" ? fill.door.trim() : "";
    const value = fillText(fill.value, FILL_VALUE_MAX);
    if (SCREEN_ANCHOR_RE.test(door) && value !== null) out.fill = { door, value };
  }
  const add = c.add as Record<string, unknown> | undefined;
  if (add && typeof add === "object") {
    const door = typeof add.door === "string" ? add.door.trim() : "";
    const fields: Record<string, string> = {};
    const raw = (add.fields ?? {}) as Record<string, unknown>;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (!ADD_KEY_RE.test(k)) continue;
        const t = fillText(v, ADD_FIELD_MAX);
        if (t === null) continue;
        // The model's empty-as-a-word is nothing (cn-v1112's lesson): never a unit called "null".
        if (["null", "none", "undefined", "n/a", "nil"].includes(t.toLowerCase())) continue;
        fields[k] = t.replace(/\s+/g, " ");
        if (Object.keys(fields).length >= ADD_FIELDS_MAX) break;
      }
    }
    if (SCREEN_ANCHOR_RE.test(door) && Object.keys(fields).length) out.add = { door, fields };
  }
  return out;
}

/** Every COMPLETE screen block in the stream so far, in order (the client performs each once;
 *  an unparseable block stays in the list as an empty step so the count never slips). */
export function screenBlocks(full: string): AgentScreen[] {
  const re = new RegExp(SCREEN_OPEN + "([\\s\\S]*?)" + SCREEN_CLOSE, "g");
  const out: AgentScreen[] = [];
  for (const m of full.matchAll(re)) {
    try {
      out.push(sanitizeScreen(JSON.parse(m[1])));
    } catch {
      out.push({});
    }
  }
  return out;
}

/** THE ENVELOPE'S JSON, read up to the next block. A directive (confirm / open / pick) rides at
 *  the END of the stream, but the holding count (0394) rode AFTER it from 10-14 to 10-15, so
 *  `JSON.parse(everything after the marker)` threw: no card, no spoken question, the mic opened on
 *  a plain turn, and Nort "froze" with the screen locked (Erik, both nights). null when there is
 *  no envelope or it does not read as an object. One reader for all three markers and the
 *  recovered turn. */
export function directivePayload<T extends object>(full: string, marker: string): T | null {
  const at = full.indexOf(marker);
  if (at < 0) return null;
  let body = full.slice(at + marker.length);
  for (const m of [HOLDING_OPEN, STATUS_OPEN, DRAFT_OPEN, HUD_OPEN, SCREEN_OPEN, CONFIRM_MARKER, OPEN_MARKER, PICK_MARKER]) {
    const cut = body.indexOf(m);
    if (cut >= 0) body = body.slice(0, cut);
  }
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
}
