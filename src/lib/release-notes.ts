import { APP_VERSION } from "@/lib/version";

/**
 * WHAT SHIPPED — one line per release, newest first. The changelog Nort reads (the whats_new tool).
 *
 * Erik, the first night Nort spoke first (2026-10-14): the eight "updates" Nort handed over were
 * reports he had filed weeks before, and when he asked "are there any newer updates?" Nort had
 * nothing: "I don't have a tool that pulls a changelog." The updates on things a person REPORTED
 * are one thing (lib/nort/updates — their own rows); what the app itself gained is this list.
 * Nort reads it back newest first with the date, and names the build this phone is running.
 *
 * MAINTAINED WITH THE VERSION BUMP: every release adds its line at the top — the same sentence
 * the release commit carries, in plain words for the person using the app (never a file name or
 * a migration number). A test holds the top entry to APP_VERSION so a bump cannot forget it.
 */
export type ReleaseNote = { version: string; date: string; line: string };

export const RELEASE_NOTES: ReleaseNote[] = [
  { version: "cn-v1125", date: "2026-10-20", line: "Nort is told on every turn whether you are on the clock and on which job, read fresh, so he never says it from memory of an earlier turn." },
  { version: "cn-v1124", date: "2026-10-20", line: "Inside the app the site fence may take a silent location fix, since the app holds that permission, so a punch made through Nort gets its fence; the fence says in the console what it did." },
  { version: "cn-v1123", date: "2026-10-20", line: "43 audit findings closed: an address or caption is saved only when the write says so, a taken-back punch puts the job back on hold, and Nort looks before he says a job is not there or where you are." },
  { version: "cn-v1122", date: "2026-10-19", line: "Nort says a thing was done only when the app did it, a job you name at clock-in is the job the punch lands on, and the clock and the site fence follow his punches at once." },
  { version: "cn-v1121", date: "2026-10-17", line: "An audit's fixes: a kit task's hours follow its first count, a one-tap Passed never overwrites a result the office recorded, Nort's hours box refuses minutes, and his voice stays on after a yes." },
  { version: "cn-v1120", date: "2026-10-16", line: "3D Scan paints a truer model at a third of the size: even light along a wall, the picture as the camera saw it, a whole room or shop no longer refused; a file too big to send says so in words." },
  { version: "cn-v1119", date: "2026-10-16", line: "3D Scan rebuilt: the phone photographs as you walk and the surfaces stay blue until a photo has them, then Finish builds the model. Measure, Measure Area and 3D Scan sit together under Lidar." },
  { version: "cn-v1118", date: "2026-10-16", line: "Open In AR works inside the North app: a 3D scan opens in Apple's viewer with its AR tab, straight from the 3D viewer's bar." },
  { version: "cn-v1117", date: "2026-10-16", line: "Scan In 3D on the task sheet: walk a room or a site and the phone builds a textured 3D model you can turn and zoom in North, drop into the room in AR on an iPhone, and show on the portal." },
  { version: "cn-v1116", date: "2026-10-16", line: "The measure and scan buttons sit in their own row under Measurements, and scanning a room or a site again replaces that scan's earlier rows instead of adding a second set." },
  { version: "cn-v1115", date: "2026-10-16", line: "Scan The Site and Scan The Room on the task sheet: walk the corners outdoors or the walls indoors, and the sides, area and perimeter land as rows with a to-scale plan drawing and a 3D file." },
  { version: "cn-v1114", date: "2026-10-16", line: "Nort can type for you: a note, hours, an answer or a measurement goes into the box on the visit sheet, as you said it. Measure a length or an area with the camera, right on the task sheet." },
  { version: "cn-v1113", date: "2026-10-16", line: "A sign-in check that gets no answer for a moment no longer sends you to the login screen: the app tries again and says so if it still can't; a refused session is now reported" },
  { version: "cn-v1112", date: "2026-10-16", line: "Nort can fix a visit's address by voice (move it, re-address it, or both); a field he leaves empty no longer shows as null on the confirm card, and the card lists no record ids" },
  { version: "cn-v1111", date: "2026-10-16", line: "A yes-or-no question from Nort reaches the phone again: the card shows, the question is spoken, and your yes runs it, on screen or with the screen locked" },
  { version: "cn-v1110", date: "2026-10-15", line: "A confirm question Nort asks by voice is retried and traced if its clip fails; the appointment form has New Lead and New Customer in plain sight and an address picker; Nort reads no cost back" },
  { version: "cn-v1109", date: "2026-10-15", line: "Nort no longer keeps a price said with a materials line, and a list drafted from a scope carries no guessed prices or vendors: the price book and the supplier's bill are the cost" },
  { version: "cn-v1108", date: "2026-10-15", line: "New Inspection on the + menu; a tapped time on the schedule offers a new appointment there too; the materials checklist shows no prices (a bill is the cost) and says In Stock where Shop Stock has it" },
  { version: "cn-v1107", date: "2026-10-15", line: "Permits read right on the phone; an inspection is Passed in one tap and the permit follows it; a punch undone within two minutes leaves no row; a job's Time tab counts the shifts not billed yet" },
  { version: "cn-v1106", date: "2026-10-15", line: "On the phone app, Nort's voice now plays through the app itself, not the web page, so his replies are heard with the screen locked; a shell without the new build plays as before" },
  { version: "cn-v1105", date: "2026-10-15", line: "The phone app's trace also follows each sentence of Nort's reply, so a reply that stops after its first sentence with the screen locked can be placed" },
  { version: "cn-v1104", date: "2026-10-15", line: "The phone app notes when Nort's panel closes on its own, so an unlock that ends a conversation can be traced to its cause" },
  { version: "cn-v1103", date: "2026-10-15", line: "On the phone app, Nort's voice no longer fades out with the screen locked: the page is woken fast only while he's working on your turn, not while he speaks" },
  { version: "cn-v1102", date: "2026-10-15", line: "Nort answers faster with the screen locked on the phone app: the page is woken every half second while it's dark instead of every five" },
  { version: "cn-v1101", date: "2026-10-15", line: "The phone app's trace of a screen-off conversation reaches the ops sink by itself when the screen comes back, so the cable is no longer needed to read it" },
  { version: "cn-v1100", date: "2026-10-15", line: "Nort now takes you to a job's Permits tab when you ask, instead of saying he can't; the phone app keeps a trace while Nort listens so a screen-off problem can be found" },
  { version: "cn-v1099", date: "2026-10-14", line: "On the phone app, Nort's mic is the app's own: it records each turn natively and keeps listening after the screen locks; the web mic is unchanged" },
  { version: "cn-v1098", date: "2026-10-14", line: "Nort's screen-off keep-alive is switched off again on the phone app: it broke the mic after the first turn; the fence stays; native recording is the next step" },
  { version: "cn-v1097", date: "2026-10-14", line: "On the phone app: Nort holds a real audio session so he can keep going after the screen locks, and the job's fence can wake the phone when you drive off and ask if you're still working" },
  { version: "cn-v1096", date: "2026-10-14", line: "A name typed into a visit's For box can be added as a new lead in one tap; Decks and Deck are one scope; a kit's box says Scope; Nort says a screen move once" },
  { version: "cn-v1095", date: "2026-10-14", line: "Nort drives the screen: say show me, take me to or where is, and he goes there, rings the spot and parks his box as a bar while he keeps talking; it points, it never presses" },
  { version: "cn-v1094", date: "2026-10-14", line: "The scope is a playbook setting, typed freely or picked from your own words, and its word offers the kits filed under it as tasks; a task opens with its own photos, measurements and note; a jump bar" },
  { version: "cn-v1093", date: "2026-10-14", line: "Nort can say what's new in the app and whether your phone has it, hands over everything he holds at one yes, says how far back it was filed, and skips it when you say so" },
  { version: "cn-v1092", date: "2026-10-13", line: "A greeting you answer over counts as asked, and what Nort holds is told at every turn's end" },
  { version: "cn-v1091", date: "2026-10-13", line: "Nort speaks first: a greeting the moment the mic is ready, by your name, naming what he holds and asking once" },
  { version: "cn-v1090", date: "2026-10-13", line: "Who's on the clock lives inside My Day's clock" },
  { version: "cn-v1089", date: "2026-10-13", line: "The address box looks where you are, a pick is a tap, and Use My Location is on the Inspector" },
  { version: "cn-v1088", date: "2026-10-11", line: "An estimate prints one row per part, Decline asks before it declines, and a task can be dismissed" },
  { version: "cn-v1087", date: "2026-10-11", line: "An estimate's plain rows follow it into a revision" },
  { version: "cn-v1086", date: "2026-10-11", line: "A wave of fixes from the October audit" },
  { version: "cn-v1085", date: "2026-10-11", line: "An estimate may be revised, and the revision supersedes it" },
  { version: "cn-v1084", date: "2026-10-11", line: "The estimate's deferred list is finished" },
  { version: "cn-v1083", date: "2026-10-10", line: "The buy list follows the estimate" },
  { version: "cn-v1082", date: "2026-10-10", line: "A part prints with the count it carries" },
  { version: "cn-v1081", date: "2026-10-10", line: "Reading your kits says how it went" },
  { version: "cn-v1080", date: "2026-10-10", line: "The Inspector's kit preview names a part as the estimate will" },
  { version: "cn-v1079", date: "2026-10-10", line: "A job follows its estimate" },
  { version: "cn-v1078", date: "2026-10-10", line: "A discount prints as a discount" },
  { version: "cn-v1077", date: "2026-10-10", line: "The estimate's units box re-derives a kit-built line for another count" },
  { version: "cn-v1076", date: "2026-10-10", line: "A priced task is remembered as a kit, and a kit is a task on the next visit" },
  { version: "cn-v1075", date: "2026-10-10", line: "A job is born with its tasks, and one estimate makes one work order and one list" },
  { version: "cn-v1074", date: "2026-10-09", line: "The estimate builder edits the task behind a line, and Draft With Estimator splits the scope into tasks instead of pricing them" },
  { version: "cn-v1073", date: "2026-10-09", line: "A task is the unit on the Inspector, each with its hours and its parts" },
  { version: "cn-v1072", date: "2026-10-09", line: "One person one row on Needs You, claims read by the cost, and a paid bill says how and when" },
  { version: "cn-v1071", date: "2026-10-08", line: "One word for a visit's ending, the win is the job it became, the My Day row opens its visit, and Edit Details escapes the glass menu" },
  { version: "cn-v1070", date: "2026-10-08", line: "A visit's outcome stamps it, and a past day reads as ago" },
  { version: "cn-v1069", date: "2026-10-08", line: "A visit closes when its estimate moves, the typed take-off reaches the estimate and the job, and a T&M job reports back" },
  { version: "cn-v1068", date: "2026-10-07", line: "A merchant's bank row opens, a match teaches the supplier's spelling, a refund records in one tap, the supplier box asks did you mean, and Waiting To Be Billed" },
  { version: "cn-v1067", date: "2026-10-07", line: "A bill knows how much of it is paid, and a payment says which bills it paid" },
  { version: "cn-v1066", date: "2026-10-07", line: "One rule names the job on a supplier's paper, and a purchase is one purchase with its corrections" },
  { version: "cn-v1065", date: "2026-10-07", line: "A bill may correct an earlier bill, and one bank line can change its answer" },
  { version: "cn-v1064", date: "2026-10-07", line: "The contract job page opens again" },
  { version: "cn-v1063", date: "2026-10-04", line: "The bills list is in the order of the paper" },
  { version: "cn-v1062", date: "2026-10-04", line: "The permit follows its visits" },
  { version: "cn-v1061", date: "2026-10-04", line: "Personal is the Owner's Draw" },
  { version: "cn-v1060", date: "2026-10-03", line: "A job is born billing the way this company bills" },
];

export const NOTES_DEFAULT = 12;
export const NOTES_MAX = 40;
/** The notes start here; anything older is not in the list, and the tool says so. */
export const HISTORY_FROM = "cn-v1060";

/** The number in "cn-v1093", or null for anything else. */
export function versionNumber(v: string | null | undefined): number | null {
  const m = /^cn-v(\d{1,6})$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * The notes newer than `since` (a version), newest first, capped. No `since` (or one we don't
 * know) = the newest `limit`. The running build is APP_VERSION; the caller says it.
 */
export function notesSince(since?: string | null, limit: number = NOTES_DEFAULT): ReleaseNote[] {
  const cap = Math.max(1, Math.min(NOTES_MAX, Math.round(Number.isFinite(limit) ? limit : NOTES_DEFAULT)));
  const n = versionNumber(since);
  const pool = n === null ? RELEASE_NOTES : RELEASE_NOTES.filter((r) => (versionNumber(r.version) ?? 0) > n);
  return pool.slice(0, cap);
}

/** True when `phone` is a known build older than `latest`; null when the phone's build is unknown. */
export function isBehind(phone: string | null | undefined, latest: string = APP_VERSION): boolean | null {
  const p = versionNumber(phone);
  const l = versionNumber(latest);
  return p === null || l === null ? null : p < l;
}
