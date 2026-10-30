import type { WordCatalog } from "./types";

/**
 * THE USAGE METER'S WORDS (us_, cn-v1140): the one meter, like the Claude usage window — a ring with
 * the percent in it (components/usage-ring, its aria label), the line under it in each state
 * (lib/usage-words: "Resets Nov 1.", the pace forecast, almost, used up), the trial's last day, the
 * two doors beside it (Add Usage, Upgrade — Title Case in both languages, Erik's law), the two
 * notices the daily cron sends once a month each (lib/usage-notices: 80% and used up) with their
 * email button, and the estimator's one line for the lighter month (quotes/actions).
 *
 * Erik's design, 2026-10-30: "usage is understandable to anyone; I don't want to have to explain all
 * that to people." So no word here names a dollar, a token or an estimate as a unit: Usage = Uso, a
 * percent, a date. Spanish is tú, US/Mexican. A date slot is filled by lib/usage-window shortDate in
 * the person's language ("Nov 1" / "1 nov").
 */
export const words: WordCatalog = {
  prefix: "us_",
  files: ["src/components/usage-ring.tsx", "src/lib/usage-words.ts", "src/app/(app)/settings/plan-card.tsx"],
  // The tiers' names are product names (what the Stripe receipt says), the same in both languages.
  sameInBoth: ["us_plan", "us_plan_handyman", "us_plan_crew", "us_plan_company"],
  en: {
    us_usage: "Usage",
    us_ringAria: "Usage: {pct}% of this month",

    // The line under the ring, by state.
    us_resets: "Resets {date}.",
    us_watchPace: "At this pace you'll run out around {runOut}. Resets {date}.",
    us_forecast: "At this pace you'll run out around {runOut}.",
    us_watch: "Most of this month's usage is used. Resets {date}.",
    us_almost: "Almost out for this month. Resets {date}.",
    us_out: "Used up for this month — Nort and the estimator run lighter until {date}. Add usage or upgrade.",
    // The same line inside the App Store app, which has no purchase door (Apple 3.1.1): no call to action.
    us_out100Shell: "Used up for this month — Nort and the estimator run lighter until {date}.",
    us_trialEnds: "Your trial ends {date}.",

    // The two doors beside the ring (builder U1 draws them), and the one that was already there.
    us_door_addUsage: "Add Usage",
    us_door_upgrade: "Upgrade",
    us_door_manageBilling: "Manage Billing",

    // THE PLAN CARD (settings/plan-card, cn-v1140): its title, the plan's name by the one access
    // rule's reason (a tier's own name, the trial, a comped company, a subscription on a price the
    // ladder does not name, or none), the office's line, and the two lines the URL carries back.
    us_cardTitle: "Plan & subscription",
    us_plan: "Plan",
    us_plan_handyman: "Handyman",
    us_plan_crew: "Crew",
    us_plan_company: "Company",
    us_plan_trial: "Free Trial",
    us_plan_comped: "Comped",
    us_plan_subscribed: "Subscribed",
    us_plan_none: "No Plan",
    us_askOwner: "Ask {first} to change the plan.",
    // No owner name on file: a whole sentence, not a slot word — Spanish contracts "a el" to "al".
    us_askTheOwner: "Ask the owner to change the plan.",
    // The estimator's first question line for the lighter month (quotes/actions guardEstimator), in
    // the caller's language; the App Store app reaches it too, so no purchase door is named.
    us_estimatorLighter: "Your company's usage for this month is used up, so this estimate runs on the lighter model until {date}.",
    us_billingOff: "Billing isn't turned on yet.",
    us_subscribedThanks: "Subscription active — thank you!",
    us_added: "Added — it shows on the ring within a minute.",

    // The two notices (builder U2's cron step), once a month each.
    us_notice80Title: "Usage: 80% Of This Month",
    us_notice80Body: "Most of this month's usage is used. It resets {date}. Nothing stops: past 100%, Nort and the estimator run lighter until then.",
    us_notice100Title: "Usage: Used Up For This Month",
    us_notice100Body: "This month's usage is used up, so Nort and the estimator run on the lighter model until {date}. Add usage or upgrade in Settings › Getting Paid.",
    // The email's button under both notices (the billing family's words).
    us_noticeOpenSettings: "Open Settings",
  },
  es: {
    us_usage: "Uso",
    us_ringAria: "Uso: {pct}% de este mes",

    us_resets: "Se reinicia el {date}.",
    us_watchPace: "A este ritmo se te acaba alrededor del {runOut}. Se reinicia el {date}.",
    us_forecast: "A este ritmo se te acaba alrededor del {runOut}.",
    us_watch: "Ya se usó la mayor parte de este mes. Se reinicia el {date}.",
    us_almost: "Casi se acaba por este mes. Se reinicia el {date}.",
    us_out: "Se acabó por este mes: Nort y el estimador corren más ligeros hasta el {date}. Agrega uso o mejora tu plan.",
    us_out100Shell: "Se acabó por este mes: Nort y el estimador corren más ligeros hasta el {date}.",
    us_trialEnds: "Tu prueba termina el {date}.",

    us_door_addUsage: "Agregar Uso",
    us_door_upgrade: "Mejorar Plan",
    us_door_manageBilling: "Administrar Facturación",

    us_cardTitle: "Plan y suscripción",
    us_plan: "Plan",
    us_plan_handyman: "Handyman",
    us_plan_crew: "Crew",
    us_plan_company: "Company",
    us_plan_trial: "Prueba Gratis",
    us_plan_comped: "Cortesía",
    us_plan_subscribed: "Suscrito",
    us_plan_none: "Sin Plan",
    us_askOwner: "Pídele a {first} que cambie el plan.",
    us_askTheOwner: "Pídele al dueño que cambie el plan.",
    us_estimatorLighter: "El uso de tu empresa por este mes se agotó, así que este presupuesto corre en el modelo más ligero hasta el {date}.",
    us_billingOff: "La facturación aún no está activada.",
    us_subscribedThanks: "Suscripción activa. ¡Gracias!",
    us_added: "Agregado: se verá en el anillo en un minuto.",

    us_notice80Title: "Uso: 80% De Este Mes",
    us_notice80Body: "Ya se usó la mayor parte de este mes. Se reinicia el {date}. Nada se detiene: pasado el 100%, Nort y el estimador corren más ligeros hasta entonces.",
    us_notice100Title: "Uso: Agotado Por Este Mes",
    us_notice100Body: "El uso de este mes se agotó, así que Nort y el estimador corren en el modelo más ligero hasta el {date}. Agrega uso o mejora tu plan en Ajustes › Cobros.",
    us_noticeOpenSettings: "Abrir Ajustes",
  },
};
