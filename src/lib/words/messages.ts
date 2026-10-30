import type { WordCatalog } from "./types";

/**
 * THE TEXTS, PUSHES AND BELL LINES A TECH GETS (nb_, cn-v1138): the 7 AM "you haven't clocked in"
 * text, the two 6 PM texts, the 12-hour "still on the clock?" question (push, bell line and text)
 * and the "you're on this job" line. Each cron reads `language` beside `phone` in the people select
 * it already makes and speaks per recipient (translator(row.language)); crew-notify hands
 * notifyPeople a function of the language and the recipients are grouped by it. The English is
 * byte-for-byte what each sender said before. A text stays as short as its English: the Spanish
 * carries its accents, which a carrier sends as UCS-2 (70 characters a segment instead of 160), so
 * every Spanish text is kept to the English's length or under.
 *
 * The office's long-shift words (nb_office…) are read in ENGLISH today (sh_spanishCovers: the
 * office pages' contents stay in English for now); they live here so the route keeps no literal, and
 * the day the office reads Spanish the route swaps "en" for the reader's language and nothing else moves.
 */
export const words: WordCatalog = {
  prefix: "nb_",
  files: ["src/app/api/timeclock/nudge/route.ts", "src/app/api/timeclock/eod-reminder/route.ts", "src/app/api/timeclock/long-shift/route.ts", "src/lib/crew-notify.ts"],
  sameInBoth: [],
  en: {
    // /api/timeclock/nudge: the company's 7 AM, to a tech who has not clocked in.
    nb_nudgeMorning: "Good morning {name}! You haven't clocked in yet. Open Contractor North to clock in.",
    // /api/timeclock/eod-reminder: the company's 6 PM.
    nb_eodStillIn: "Hi {name} — you're still clocked in. Please clock out and fill out your end-of-day form in Contractor North.",
    nb_eodNoForm: "Hi {name} — please fill out your end-of-day form (what you worked on today) in Contractor North.",
    // /api/timeclock/long-shift, the person whose clock it is. The lead names the shift's start, and
    // after a Switch Job the piece's job with the time the switch put him there (audit v994 SW1).
    nb_crewClockedInSince: "You've been clocked in since {since}",
    nb_crewClockedInAtSince: "You've been clocked in at {label} since {since}",
    nb_crewOnClockSince: "You've been on the clock since {since}",
    nb_crewOnClockSinceAt: "You've been on the clock since {since} (at {label} since {switchAt})",
    nb_stillOnClockTitle: "Still On The Clock?",
    nb_stillOnClockBody: "{crewLead}. Tap to set when you stopped.",
    nb_stillOnClockText: "{crewLead}, more than {hours} hours. Open Timeclock to set when you stopped.",
    // /api/timeclock/long-shift, the office (English today).
    nb_officeStillTitle: "{first} Is Still On The Clock",
    nb_officeClockedIn: "Clocked in {since}, {hours} hours ago",
    nb_officeClockedInAt: "Clocked in {since} at {label}, {hours} hours ago",
    nb_officeOnClock: "On the clock since {since}, {hours} hours",
    nb_officeOnClockAt: "On the clock since {since}, {hours} hours; at {label} since {switchAt}",
    nb_officeBellBody: "{officeLead}. If the shift is over, {door} on Timecards.{tail}",
    nb_officeTailMorning: " {first} is asked in the morning.",
    nb_officeTailAtHours: " At {hours} hours {first} is asked.",
    nb_officeBuzzAsked: "{officeLead}. {first} has been asked when the shift ended. {door} on Timecards if you know.",
    nb_officeBuzzGone: "{officeLead} (no longer on your crew). {door} on Timecards if you know.",
    // lib/crew-notify: added to a job's crew.
    nb_jobAssignedTitle: "New job assigned",
    nb_jobAssignedBody: "You're on {label}.",
    nb_aJob: "a job",
    // appointments/actions: a visit put on a tech's name (the body is the visit's own title).
    nb_apptAssignedTitle: "New appointment assigned",
  },
  es: {
    nb_nudgeMorning: "¡Buenos días, {name}! Aún no marcas entrada. Abre Contractor North para marcar entrada.",
    nb_eodStillIn: "Hola, {name}: sigues con entrada marcada. Marca salida y llena tu reporte del día en Contractor North.",
    nb_eodNoForm: "Hola, {name}: llena tu reporte del día (en qué trabajaste hoy) en Contractor North.",
    nb_crewClockedInSince: "Tienes entrada marcada desde {since}",
    nb_crewClockedInAtSince: "Tienes entrada marcada en {label} desde {since}",
    nb_crewOnClockSince: "Llevas en el reloj desde {since}",
    nb_crewOnClockSinceAt: "Llevas en el reloj desde {since} (en {label} desde {switchAt})",
    nb_stillOnClockTitle: "¿Sigues En El Reloj?",
    nb_stillOnClockBody: "{crewLead}. Toca para poner a qué hora paraste.",
    nb_stillOnClockText: "{crewLead}, más de {hours} horas. Abre el Reloj para poner a qué hora paraste.",
    nb_officeStillTitle: "{first} Sigue En El Reloj",
    nb_officeClockedIn: "Marcó entrada {since}, hace {hours} horas",
    nb_officeClockedInAt: "Marcó entrada {since} en {label}, hace {hours} horas",
    nb_officeOnClock: "En el reloj desde {since}, {hours} horas",
    nb_officeOnClockAt: "En el reloj desde {since}, {hours} horas; en {label} desde {switchAt}",
    nb_officeBellBody: "{officeLead}. Si el turno terminó, {door} en Tarjetas de Tiempo.{tail}",
    nb_officeTailMorning: " A {first} se le pregunta en la mañana.",
    nb_officeTailAtHours: " A las {hours} horas se le pregunta a {first}.",
    nb_officeBuzzAsked: "{officeLead}. Ya se le preguntó a {first} cuándo terminó el turno. {door} en Tarjetas de Tiempo si lo sabes.",
    nb_officeBuzzGone: "{officeLead} (ya no está en tu cuadrilla). {door} en Tarjetas de Tiempo si lo sabes.",
    nb_jobAssignedTitle: "Nuevo trabajo asignado",
    nb_jobAssignedBody: "Estás en {label}.",
    nb_aJob: "un trabajo",
    nb_apptAssignedTitle: "Nueva cita asignada",
  },
};
