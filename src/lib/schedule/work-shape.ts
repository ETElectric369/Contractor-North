/**
 * WHAT KIND OF WORK IS THIS, AND HOW LONG WILL IT TAKE.
 *
 * Erik, planning a real week: "I see all the jobs but have no way to determine what goes where …
 * what i need to know is how much time they are going to take hours or days and a tag showing
 * service call, job, inspection/walk through, or office, that way i can look at them and see
 * immediately which ones go together and put them on a day am or pm then if one has 6 hours set
 * and the other has 1 hour set i can see that the visit is on the way."
 *
 * Two facts per item, and between them a day becomes plannable by eye rather than by arithmetic:
 * a 6h job and a 1h walk-through in the same town is a full day with a stop on the way; two 6h
 * jobs is two days whatever the map says.
 *
 * ── ONE THING IS NEW, THE OTHER ALREADY EXISTED ────────────────────────────────────────────
 *
 * TYPE was already there and merely unseen: appointments carry inspection / final_inspection /
 * service_call / quote / meeting, and a job is its own kind. Nothing needed modelling; it needed
 * showing. Adding a second type vocabulary would have created two answers to one question.
 *
 * DURATION did not exist anywhere in the schema (0229 adds planned_minutes). `scheduled_start` and
 * `scheduled_end` are a date SPAN — which days a job occupies — and say nothing about effort. Every
 * walk-through in production had a null `ends_at`, so appointments were points, not blocks.
 */

/** The tags Erik named, in his words. A job is a kind; the rest come off appointments.type. */
export type WorkKind = "job" | "walkthrough" | "service" | "office" | "quote" | "other";

const APPT_KIND: Record<string, WorkKind> = {
  // 0231. A day marked as the WORK is not a walk-through, and calling it one was the app
  // overruling the only person who knew — twice, silently.
  job: "job",
  inspection: "walkthrough",
  final_inspection: "walkthrough",
  service_call: "service",
  meeting: "office",
  quote: "quote",
  appointment: "other",
  other: "other",
};

/**
 * BACK THE OTHER WAY: what kind is this appointment already?
 *
 * appointmentTypeFor maps a chosen kind onto appointments.type at booking. Reading it back needs
 * the inverse, or the kind dropdown on an already-booked visit shows "Kind?" forever — the card
 * saying "Service call" in its badge and "Kind?" in its control, about itself, at the same time.
 *
 * Only a TYPE it actually carries maps; a null type stays null, so an untyped visit honestly reads
 * "Kind?" rather than being shown a guess as though somebody had answered.
 */
export const KIND_FROM_APPT_TYPE: Record<string, WorkKind> = APPT_KIND;

export function workKind(i: { kind?: "lead" | "job" | "appointment"; type?: string | null; workKind?: string | null }): WorkKind {
  // WHAT HE TOLD THE APP BEATS WHAT THE APP WORKED OUT. A lead's own work_kind (0230) is a person's
  // answer given at the moment they knew; everything below it is inference.
  const told = String(i.workKind ?? "");
  if ((["job", "walkthrough", "service", "office", "quote", "other"] as string[]).includes(told)) {
    return told as WorkKind;
  }
  if (i.kind === "job") return "job";
  // A LEAD's next step is a walk-through — that is the only thing a lead can be scheduled as, and
  // it is what scheduleLeadsOnDay books.
  // An untyped item on the rail is a site visit — that is the only thing a lead can be booked as,
  // and an appointment sitting undated is one somebody agreed to and never dated. "Other" would be
  // an honest-looking shrug at a question that has a real answer.
  if ((i.kind === "lead" || i.kind === "appointment") && !i.type) return "walkthrough";
  return APPT_KIND[String(i.type ?? "")] ?? "other";
}

/** Short enough to sit on a chip in a calendar cell. */
export const KIND_LABEL: Record<WorkKind, string> = {
  job: "Job",
  walkthrough: "Walk-through",
  service: "Service call",
  office: "Office",
  quote: "Quote",
  other: "Other",
};

/** Badge tones, borrowed from the app's one palette so nothing invents a colour. */
export const KIND_TONE: Record<WorkKind, "blue" | "green" | "amber" | "slate" | "indigo"> = {
  job: "blue",
  walkthrough: "green",
  service: "amber",
  office: "slate",
  quote: "indigo",
  other: "slate",
};

/** A working day. Used to render minutes as days once they stop reading as hours. */
export const WORK_DAY_MINUTES = 480;

/**
 * Minutes as a contractor says them.
 *
 * BLANK IS NOT ZERO. An unsized job renders "—", never "0h": zero is a claim that it takes no
 * time, blank is the truth that nobody has sized it. Erik must be able to tell the two apart at a
 * glance, because one is ready to plan and the other is a question.
 */
export function durationLabel(minutes: number | null | undefined): string {
  const m = Number(minutes ?? 0);
  if (!Number.isFinite(m) || m <= 0) return "—";
  if (m < 60) return `${m}m`;
  if (m < WORK_DAY_MINUTES) {
    const h = m / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
  }
  const days = m / WORK_DAY_MINUTES;
  if (days < 2) {
    // 8–15h reads better as hours than as "1.4 days" — a long day is still a day.
    const h = m / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
  }
  return `${Number.isInteger(days) ? days : days.toFixed(1)} days`;
}

/** True when this is a big enough block that it OWNS the day rather than sharing it. */
export const fillsTheDay = (minutes: number | null | undefined): boolean =>
  Number(minutes ?? 0) >= WORK_DAY_MINUTES * 0.75;

/**
 * What a day already holds, in the terms that decide whether one more thing fits.
 *
 * Deliberately not a scheduler. It reports; the person decides. An unsized item counts toward
 * `unsized` rather than being assumed to take nothing — silently treating unknown as zero is how
 * a day looks free right up until you arrive at it.
 */
export function dayLoad(items: { planned_minutes?: number | null }[]): {
  minutes: number;
  unsized: number;
  label: string;
} {
  let minutes = 0;
  let unsized = 0;
  for (const i of items) {
    const m = Number(i.planned_minutes ?? 0);
    if (m > 0) minutes += m;
    else unsized++;
  }
  const parts: string[] = [];
  if (minutes > 0) parts.push(durationLabel(minutes));
  if (unsized > 0) parts.push(`${unsized} unsized`);
  return { minutes, unsized, label: parts.join(" · ") };
}


/**
 * The appointment type a lead's kind books AS.
 *
 * THE TAG DOES NOT GET RE-DECIDED AT EACH STAGE — that is the whole of Erik's "interconnected".
 * He picks "Service call" on the lead; the booking becomes appointments.type = 'service_call'; the
 * calendar chip reads "Service call" because workKind maps it straight back. One choice, made once,
 * at the moment somebody actually knew.
 *
 * `quote` books as itself — you are going out to price it. `job` books as a JOB (0231): Erik
 * marked Matt Warren a full-day job and got "Site inspection, one hour", because this function used
 * to fold job into inspection. The assumption behind that fold — you always look before you work —
 * is simply false for the work he already knows: a panel swap he quoted last month is a Monday, not
 * a visit. When somebody says the word, the app's job is to write it down, not to correct it.
 */
export function appointmentTypeFor(kind: string | null | undefined): string {
  switch (kind) {
    case "service": return "service_call";
    case "office": return "meeting";
    case "quote": return "quote";
    case "job": return "job";
    default: return "inspection";
  }
}

/**
 * What to call this booking on the calendar.
 *
 * "Site inspection: Matt Warren" on a day he booked as a full day of work is the app telling him
 * what he did, incorrectly, in the one place he goes to check. The label follows the kind, and a
 * walk-through keeps the wording it always had.
 */
export function bookingTitle(kind: WorkKind, name: string): string {
  const who = String(name ?? "").trim() || "Visit";
  switch (kind) {
    case "job": return who;
    case "service": return `Service call: ${who}`;
    case "office": return `Meeting: ${who}`;
    case "quote": return `Quote: ${who}`;
    default: return `Site inspection: ${who}`;
  }
}
