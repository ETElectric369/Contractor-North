import { DOCK } from "@/lib/dock";

/**
 * THE SCREENS NORT CAN DRIVE TO, AND THE SPOTS HE CAN POINT AT (field feedback 10-13, item 6).
 *
 * One registry, three readers: the prompt block below (so what Nort is told can never lag what
 * the pages carry), the client driver (lib/nort/screen-driver finds a spot by `data-tour` or id),
 * and a test that greps the source for every name here (a renamed anchor fails CI, not Erik's
 * walk-through). The names are the tour's own (`data-tour`, components/tour) plus the ids the
 * pages already scroll to, so there is ONE vocabulary for "it's here" — the tour and Nort read it.
 *
 * It names; it never gates. A path a role cannot see redirects where the page says (a tech sent
 * to /schedule lands on My Day), and the data behind every screen is RLS's to show or hide.
 */
export type ScreenSpot = { name: string; say: string };

export type Screen = {
  /** The screen's name, as the dock or the page says it. */
  name: string;
  /** The path, with its query contract when one exists (angle brackets are placeholders). */
  path: string;
  /** One clause on the query the page reads, or what the page is. */
  say?: string;
  /** Office only (the page itself redirects a tech). */
  staffOnly?: boolean;
  /** The spots on it, by anchor name. */
  spots?: ScreenSpot[];
};

export const SCREENS: Screen[] = [
  {
    name: "My Day",
    path: "/planner",
    say: "a tech's week is ?view=week&week=1 (next week; the office's week is Schedule)",
    spots: [
      { name: "now-card", say: "the Now card: the clock and the job they're on" },
      { name: "tasks-reminders", say: "Tasks & Reminders" },
      { name: "needs-you", say: "Needs You (only while something needs them)" },
      { name: "agenda", say: "the day (Earlier / Next / Later) or a tech's week" },
    ],
  },
  {
    name: "Schedule",
    path: "/schedule",
    say: "?view=week|day&date=YYYY-MM-DD (next week = today + 7 days, view=week)",
    staffOnly: true,
    spots: [
      { name: "waiting-for-a-day", say: "Waiting For A Day, the rail of work with no day" },
      { name: "schedule-calendar", say: "the calendar" },
    ],
  },
  { name: "Clock", path: "/timeclock", say: "a tech's clock tile (the two-button clock and Switch Job)" },
  { name: "Jobs", path: "/jobs", say: "?status=<status>", spots: [{ name: "new-job", say: "New Job (office)" }] },
  {
    name: "A job",
    path: "/jobs/<id>",
    say: "?tab=job|tasks|photos|time|materials|permits|panel|appointments|wos opens that tab; costs|quotes|invoices|change-orders are the office's tabs (a tech has none)",
    spots: [
      { name: "job-status", say: "the status pill (On Hold, Finished…)" },
      { name: "job-clock", say: "Clock In / Switch, the job's one clock" },
      { name: "job-tabs", say: "the tab strip" },
      { name: "job-manage", say: "Manage ⋯ (office: Edit, Finish, Delete)" },
    ],
  },
  { name: "Estimates", path: "/quotes", say: "?status=; the builder is /quotes/new; one estimate is /quotes/<id>", staffOnly: true, spots: [{ name: "new-estimate", say: "New Estimate" }] },
  {
    name: "Invoices",
    path: "/billing",
    say: "one invoice is /billing/<id>",
    staffOnly: true,
    spots: [
      { name: "owed-to-you", say: "Owed To You" },
      { name: "customers", say: "By Customer (also ?open=customers)" },
      { name: "waiting", say: "Waiting To Be Billed" },
      { name: "payments", say: "Payments In" },
    ],
  },
  {
    name: "Bills",
    path: "/bills",
    say: "?q=<search>",
    staffOnly: true,
    spots: [
      { name: "needs-you", say: "Needs You: papers to sort, supplier bills not in the books (only while there are some)" },
      { name: "suppliers", say: "the Suppliers card, what is owed to each" },
      { name: "add-by-hand", say: "Add By Hand, the typed cost sheet" },
      { name: "all-bills", say: "All Bills" },
    ],
  },
  { name: "Customers", path: "/crm", say: "?q=<search>; one customer is /crm/<id>", staffOnly: true },
  { name: "Leads", path: "/leads", staffOnly: true },
  { name: "Inspections", path: "/inspections", staffOnly: true },
  {
    name: "An inspection (the visit sheet)",
    path: "/appointments/<id>",
    say: "?task=<task id> opens one task",
    spots: [
      { name: "insp-where", say: "Where" },
      { name: "need-tasks", say: "the Tasks" },
      { name: "insp-photos", say: "Photos" },
      { name: "insp-notes", say: "Notes (when the sheet has a notes box)" },
      { name: "task-<id>", say: "one task's row" },
      { name: "need-<question key>", say: "one question" },
    ],
  },
  {
    name: "Settings",
    path: "/settings",
    say: "?tab=<cluster> opens a cluster",
    spots: [
      { name: "settings-playbook", say: "the Playbook (the questions)" },
      { name: "settings-you", say: "You (how Nort talks to them)" },
      { name: "settings-<cluster>", say: "a cluster's link on a computer (company, playbook, features, money, docs, getpaid, crew, customers, website, content, integrations); on a phone the links are hidden, so use ?tab= instead" },
    ],
  },
  { name: "Timecards", path: "/timecards", staffOnly: true },
  { name: "Price List", path: "/price-list", staffOnly: true },
  { name: "Analytics", path: "/analytics", staffOnly: true },
  { name: "Reconcile", path: "/reconcile", staffOnly: true },
  { name: "Team", path: "/team", staffOnly: true },
];

/** The shell's own spots, on every screen. */
export const SHELL_SPOTS: ScreenSpot[] = [
  { name: "ask", say: "Search Or Ask (top bar)" },
  { name: "nort", say: "the Nort button (top bar)" },
  { name: "quickadd", say: "the + button (top bar)" },
  { name: "bell", say: "the Bell (top bar)" },
  { name: "account", say: "their initials (top bar) — menu: \"account\" opens the menu behind them" },
  { name: "dock", say: "the dock" },
  { name: "dock-<section>", say: `one dock tile: ${DOCK.map((s) => s.key).join(", ")}` },
  { name: "account-menu", say: "the open avatar menu (menu: \"account\" first)" },
  { name: "settings-link", say: "Settings, inside the avatar menu" },
];

/** Anchor names in the registry that are LITERAL (a `data-tour` or id in the source, exactly). */
export function literalAnchorNames(): string[] {
  const names = new Set<string>();
  for (const s of SCREENS) for (const sp of s.spots ?? []) if (!sp.name.includes("<")) names.add(sp.name);
  for (const sp of SHELL_SPOTS) if (!sp.name.includes("<")) names.add(sp.name);
  return [...names];
}

/** Every path in the registry, placeholders and all (a test holds each to an internal path). */
export const screenPaths = (): string[] => SCREENS.map((s) => s.path);

const spotsLine = (spots: ScreenSpot[] | undefined) => (spots?.length ? ` — spots: ${spots.map((sp) => `[${sp.name}] ${sp.say}`).join("; ")}` : "");

/**
 * THE PROMPT BLOCK — per-org-stable text for the CACHED system block, built from the registry so
 * the words and the anchors are one thing.
 */
export function screenPromptBlock(isStaff = true): string {
  // A tech's list is a tech's app: the office's screens are not named, and a drive there is refused.
  const lines = SCREENS.filter((s) => isStaff || !s.staffOnly).map(
    (s) => `- ${s.name} ${s.path}${s.staffOnly ? " (office only)" : ""}${s.say ? ` — ${s.say}` : ""}${spotsLine(s.spots)}`,
  );
  return [
    "DRIVING THE SCREEN (show_screen) — you can TAKE the person to a screen and POINT at a spot on it, hands-free; you still never press a button for them. Call show_screen with `path` (a path below, with its query), and/or `anchor` (a spot's name: it scrolls there and rings it for a few seconds), `menu: \"account\"` to open the avatar menu, `box: \"bar\"` to park your own box as a slim bar so the screen is theirs while you keep talking (`box: \"open\"` brings it back), and `label` (3–6 words: what you're showing). It only moves and points — it saves nothing, and it is not show_card (the card is for reading a record on the glass). Use it when they say show me / take me to / where is / open the… / pull up the schedule, and whenever you explain where a button is: go there and ring it instead of describing the route. By voice, park your box (box: \"bar\") in the same call whenever you send them to a screen. Then say ONE short line about what they're looking at — once; never a second 'there you go' after the first, and no narration of your lookups in between. Two moves are two calls, in order (the job, then its Costs tab). A job's permits, inspections, panel and work orders are TABS on the job (`/jobs/<id>?tab=permits`), never screens of their own — there is no /permits path, so a permit's date is reached through its job. Dates in a path come from Today. A record's id in a path is its real id from a tool result, never a job number. The result names what could not be used (not_used) — then say where it is in words instead of claiming you showed it; a spot that is not on the screen right now (an empty Needs You, a tab a tech has not got) cannot be rung.",
    "TYPING FOR THEM (fill_screen) — on a screen with boxes, the latest app context lists BOXES ON THE SCREEN RIGHT NOW by door name ([task-note-<id>] Note on 'Panel swap'; [need-<key>] a question; [insp-notes] the visit's notes; [task-measure-<id>] / [insp-measures] add a measurement with fields label, value, unit). Call fill_screen with that door and the value AS THEY SAID IT — a number only if they gave one, a pick only from the listed choices — and the page saves it like a keystroke while they watch it land. One line about what you put where, then listen; the next turn's context says what landed or why a box refused it. If the box they mean is not in the list, take them to its screen first (show_screen; the visit sheet is /appointments/<id>) and type on the next turn. Never fill_screen on money, a customer's paper, or anything you'd confirm first — those stay a yes-or-no card.",
    "SCREENS AND THEIR SPOTS (anchor names in [brackets]; <…> is a placeholder you fill):",
    ...lines,
    `- On every screen: ${SHELL_SPOTS.map((sp) => `[${sp.name}] ${sp.say}`).join("; ")}.`,
  ].join("\n");
}
