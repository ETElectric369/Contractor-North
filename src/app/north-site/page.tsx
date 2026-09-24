import type { Metadata } from "next";
import { SITE_ORIGIN, mailto } from "./site-facts";

export const metadata: Metadata = {
  title: "Contractor North",
  description:
    "North is an app for contractors and their crews: estimates, scheduling, timecards, invoicing and an assistant called Nort. Invite-only.",
  alternates: { canonical: `${SITE_ORIGIN}/` },
};

/* Every line below is a feature that exists in the app today (onboarding truth law). What is NOT
 * here on purpose: Tap to Pay (Debug builds only), text messages (not live platform-wide),
 * QuickBooks (no keys in production), pricing (none published), and any "automatic" claim. */
const FEATURES: { name: string; line: string }[] = [
  { name: "Estimates", line: "Price from your own price list. Customers open the quote from a link and accept it online." },
  { name: "Scheduling", line: "Jobs and appointments on one calendar, assigned to the people doing them." },
  { name: "Timecards", line: "Clock in and out on the phone, on the job you pick." },
  { name: "Invoicing", line: "Send the invoice. Customers pay by card through Stripe, straight to your own account." },
  { name: "Nort", line: "An assistant you can type or talk to about your jobs, hours and money." },
];

export default function NorthHome() {
  return (
    <div className="grid gap-y-10 pb-4 pt-12 sm:pt-20 lg:min-h-[calc(100dvh-13rem)] lg:grid-cols-12 lg:grid-rows-[auto_1fr_auto] lg:gap-x-10">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#137a70] lg:col-span-7">
        North · for contractors · invite only
      </p>

      <h1 className="font-[family-name:var(--font-north-serif)] text-[30px] font-semibold leading-[1.12] tracking-tight sm:text-[44px] lg:col-span-10 lg:row-start-2 lg:self-start">
        Estimates, schedules, timecards, invoices.
        <span aria-hidden className="block h-[0.55em]" />
        <span className="block text-[#51607a]">One app for the whole crew.</span>
      </h1>

      <div className="lg:col-span-5 lg:row-start-3 lg:self-end">
        <p className="max-w-md text-[17px] leading-relaxed text-[#33425e]">
          Built by an electrical contractor in Chilcoot, California, for small crews that work in the field.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
          <a
            href={mailto("Invite request")}
            className="inline-flex h-12 items-center rounded-full bg-[#1a2b4a] px-6 text-[15px] font-semibold text-white shadow-sm hover:bg-[#233963]"
          >
            Ask For An Invite
          </a>
          <a href="/support" className="inline-flex min-h-11 items-center text-[15px] font-medium text-[#1a2b4a] underline decoration-[#1b9488] decoration-2 underline-offset-4">
            Get Help
          </a>
        </div>
        <p className="mt-3 text-[13px] text-[#51607a]">North is invite-only. Tell us who you are and what you do.</p>
      </div>

      <ul className="divide-y divide-[#d9dde5] border-y border-[#d9dde5] lg:col-span-6 lg:col-start-7 lg:row-start-3 lg:self-end">
        {FEATURES.map((f) => (
          <li key={f.name} className="grid grid-cols-[6.5rem_1fr] gap-3 py-3.5 sm:grid-cols-[8rem_1fr]">
            <span className="font-[family-name:var(--font-north-serif)] text-[17px] font-semibold">{f.name}</span>
            <span className="text-[15px] leading-snug text-[#33425e]">{f.line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
