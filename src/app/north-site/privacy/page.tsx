import type { Metadata } from "next";
import { PageHead, Section } from "../prose";
import { OPERATOR_LINE, PRIVACY_EFFECTIVE_DATE, SITE_ORIGIN, SUPPORT_EMAIL, mailto } from "../site-facts";

export const metadata: Metadata = {
  title: "Privacy · Contractor North",
  description: "What the North app collects, why, who handles it, and how to have it deleted. In plain words.",
  alternates: { canonical: `${SITE_ORIGIN}/privacy` },
};

/*
 * EVERY CLAIM HERE IS TRACED TO CODE (onboarding truth law). The inventory behind this page was
 * taken 2026-09-24 at cn-v988. If a processor, a permission or a stored field changes, this page
 * changes in the same commit. Where the pointers live:
 *   collected      supabase/migrations/0001_init.sql (profiles, customers, time_entries gps_in/out,
 *                  conversations/messages), 0041 (home_address), 0046 + 0250 (push), 0068 + 0219
 *                  (signature evidence), 0082 (bug_reports + screenshot), 0085 (user_memory),
 *                  0064 (agent audit log), 0098 (rate_limits keyed by IP), 0162 (AI usage meter)
 *   location       src/lib/geo.ts (first request rides a tap), components/geofence-monitor.tsx
 *                  (org setting geofence_logout, DEFAULT ON in lib/org-settings.ts, mounted by
 *                  (app)/layout.tsx), timeclock/actions.ts adoptGeofenceAnchor (backfills gps_in
 *                  within timeclock/adopt-window.ts: 15 min after clock-in, 45 after a job switch;
 *                  the job-page and My Day punches carry gps:null), app/api/weather/route.ts
 *                  (rounded), Info.plist has WhenInUse only and no UIBackgroundModes location
 *   public files   lead-uploads is a PUBLIC bucket (0099) written only by api/site-chat/upload;
 *                  the intake form's files go to the PRIVATE intake-uploads bucket (0186)
 *   automatic AI   intake/[handle]/actions.ts: a lead that uploads a plan PDF starts runPlanBrief
 *                  (lib/plan-brief-run.ts: the lead's name, message and files go to the model)
 *   subscription   settings/billing-actions.ts startCheckout: a Stripe customer with the company
 *                  name + email, card entered on Stripe Checkout
 *   photos         lib/image-prep.ts (the re-encode strips EXIF) used by jobs/[id]/upload-job-photos.ts
 *                  and job-notes.tsx; only job photos are promised here because other upload doors
 *                  do not all run it
 *   voice          app/api/transcribe/route.ts (audio forwarded to ElevenLabs, not stored),
 *                  app/api/tts/route.ts
 *   processors     live in production per `vercel env ls` names: Supabase, Vercel, Anthropic,
 *                  ElevenLabs, Google Maps/Places/Geocoding/Weather, Google Calendar OAuth, Resend,
 *                  Stripe, APNs, web push. Twilio sends only for an org with its own number
 *                  (lib/sms-readiness.ts). NOT named because not live: OpenAI (no key), QuickBooks
 *                  (no keys), Tap to Pay (Debug entitlement only).
 *   no ads/tracking no ad SDK, no third-party analytics, no ATT; only Vercel Speed Insights
 *   retention      no time-based purge exists anywhere (vercel.json crons do none)
 */

const PERMISSIONS: { name: string; why: string; when: string }[] = [
  { name: "Location (while using)", why: "Saves where you clocked in and out, shows local weather, and, unless your company turns it off, checks you are still at the job site while you are clocked in.", when: "the first time you clock in or tap Use My Location." },
  { name: "Camera", why: "Photograph job sites, materials, receipts and documents and attach them to the job.", when: "the first time you take a photo in North." },
  { name: "Photos", why: "Attach photos from your library, and save documents and photos back to it.", when: "the first time you pick or save a photo." },
  { name: "Microphone", why: "Talking to Nort and dictating notes. The audio goes to a speech service to become text.", when: "the first time you talk to Nort or dictate." },
  { name: "Notifications", why: "Alerts like new leads, assigned jobs and clock-out reminders.", when: "only when you turn notifications on." },
  { name: "Bluetooth", why: "Connecting a supported card reader.", when: "only if you set up a card reader." },
];

const PROCESSORS: { who: string; what: string }[] = [
  { who: "Supabase", what: "The database, sign-in and file storage. Everything described above is stored here." },
  { who: "Vercel", what: "Hosting. Handles every request, including IP addresses, and measures page speed." },
  { who: "Anthropic (Claude)", what: "Runs Nort. Gets what you ask Nort and the records it looks up to answer, which can include customer names, addresses, hours and pay. Also reads receipts, supplier invoices, plans and documents you ask North to read, and chat from a contractor's website assistant. When someone uploads a plan PDF through a contractor's intake form, the plans, their name and their message are sent automatically to be read into a summary for the contractor." },
  { who: "ElevenLabs", what: "Speech. Turns your recorded voice into text, and Nort's replies (which can name customers and addresses) into speech. Donated voice recordings, if any, go here to build Nort's voice." },
  { who: "Google", what: "Maps, address lookup and weather: the addresses you type, and a location rounded to about a kilometer for weather. The map in the app loads from Google, so Google sees your IP address, and contractors' public sites load their fonts from Google. If you connect Google Calendar, jobs and appointments sync with your calendar." },
  { who: "Stripe", what: "Payments. Card numbers are typed on Stripe's own page or read by Stripe's card reader, never stored by North. Gets amounts, invoice details, the payer's email, and the business details a contractor gives Stripe to get paid. Also bills a company's North subscription: the company name, billing email and the card entered on Stripe's page." },
  { who: "Resend", what: "Sends email: quotes, invoices, reminders and alerts. Gets the recipient's address and the message." },
  { who: "Apple and web push services", what: "Deliver notifications. Get a device token and the alert text, which can name a customer or job." },
  { who: "Twilio", what: "Text messages, only if your company sets up texting. Gets phone numbers and the message." },
];

export default function NorthPrivacy() {
  return (
    <>
      <PageHead eyebrow="Privacy policy" first="Privacy at North." second="What we collect, and why, in plain words.">
        <p className="mt-5 text-[13px] text-[#51607a]">
          Effective date:{" "}
          {PRIVACY_EFFECTIVE_DATE ?? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">to be set when this page is posted</span>}
        </p>
      </PageHead>

      <Section title="Who this covers">
        <p>
          North is an app for contractors and their crews: estimates, scheduling, timecards, invoicing and an assistant
          called Nort. This policy covers the North app on iPhone, the web app at app.contractornorth.com, and the public
          pages North hosts for contractors. {OPERATOR_LINE}
        </p>
        <p>It touches two groups of people:</p>
        <ul>
          <li><strong>People who use North</strong>: owners, office staff and crew.</li>
          <li>
            <strong>Their customers and leads.</strong> A contractor decides what to record about their own customers.
            North stores it and handles it on that contractor&apos;s behalf. If you are a contractor&apos;s customer, ask
            the contractor first; you can also write to us.
          </li>
        </ul>
      </Section>

      <Section title="What North collects">
        <ul>
          <li><strong>Your account:</strong> name, email, phone, role and profile photo. Your password is stored hashed by the sign-in service; we can&apos;t read it. If you add a passkey, North keeps only its public key.</li>
          <li><strong>Crew and pay details your company enters:</strong> home address (the starting point for mileage), pay rate and bill rate.</li>
          <li><strong>Time:</strong> clock-in and clock-out times, the job, breaks, notes, mileage and pay records.</li>
          <li><strong>Location:</strong> the phone&apos;s precise location when you clock in or out, saved with the punch, or taken shortly after clocking in or switching jobs if the punch had none. Unless your company turns off job-site clock-out, North also checks your location while you are clocked in and the app is open, and asks you (and can clock you out) when you leave the site. North asks for location only while you are using it and does not follow you in the background.</li>
          <li><strong>Photos and files:</strong> job photos, receipts, supplier invoices, licenses and certificates, plan PDFs. Job photos are re-saved on your phone before upload, which removes hidden photo data such as where the photo was taken.</li>
          <li><strong>Voice:</strong> when you talk to Nort or dictate, the recording is sent to a speech service and the text comes back. North&apos;s server passes the audio along and does not keep it.</li>
          <li><strong>Donated voice:</strong> recordings and a typed consent name from people who agree, on a consent page, to lend their voice to Nort.</li>
          <li><strong>Nort conversations:</strong> every message, the notes and business facts Nort remembers for you, a log of the actions Nort takes, and how much AI each person uses.</li>
          <li><strong>Notifications:</strong> a device token for your phone or browser, if you turn notifications on.</li>
          <li><strong>Payments:</strong> invoice amounts, payment status and card fees. Card numbers never reach North.</li>
          <li><strong>Problems:</strong> error logs, and bug reports sent by office staff, which include a screenshot of the screen and so can show customer details.</li>
          <li><strong>Page speed:</strong> performance numbers (which page, how fast, what kind of device).</li>
          <li><strong>Google Calendar</strong>, only if you connect it: North writes jobs and appointments (title, address, notes and a link) to your calendar and reads your calendar events to keep the two in sync.</li>
        </ul>
        <p>What contractors keep about their customers and leads:</p>
        <ul>
          <li>Name, company, email, phone, address, notes, jobs, quotes, invoices and payment status.</li>
          <li>Leads from a contractor&apos;s website: the form message, photos and plans people upload, and chat with the website&apos;s assistant. Plan PDFs uploaded through a contractor&apos;s intake form are read automatically by an AI service (Anthropic, below) into a summary for the contractor.</li>
          <li>Photos sent to a contractor&apos;s website chat assistant are stored at an unguessable web address, so anyone who has that exact address can open them. Files uploaded through a contractor&apos;s intake form are private.</li>
          <li>Signed contracts: the typed name, IP address, browser, time signed, and the exact text that was signed.</li>
          <li>IP addresses on public forms, to limit abuse.</li>
        </ul>
      </Section>

      <Section title="Why">
        <ul>
          <li>To sign you in and keep each company&apos;s records separate.</li>
          <li>To run the work: quotes, schedules, timecards, payroll, mileage, invoices and payments.</li>
          <li>To answer you through Nort, and to turn speech into text and text into speech.</li>
          <li>To send the emails and alerts you or your company ask for.</li>
          <li>To find and fix problems. We read error logs, bug reports and Nort conversations to do that.</li>
          <li>To stop abuse of public forms.</li>
        </ul>
      </Section>

      <Section id="shared" title="Who handles it">
        <p>North runs on these services. They process data for us to do the jobs listed; none of them gets it to sell.</p>
        <ul>
          {PROCESSORS.map((p) => (
            <li key={p.who}><strong>{p.who}:</strong> {p.what}</li>
          ))}
        </ul>
        <p>Each keeps what it receives under its own privacy policy.</p>
      </Section>

      <Section title="No ads, no selling">
        <p>
          North has no ads, no advertising trackers and no third-party analytics. We don&apos;t sell personal data or share
          it for advertising, and we don&apos;t track you across other companies&apos; apps or websites.
        </p>
        <p>
          Customer payments go to the contractor&apos;s own Stripe account. Contractor North never holds that money.
        </p>
      </Section>

      <Section title="iPhone permissions">
        <p>North asks for each one the first time a feature needs it, not when the app opens. You can change any of them in iPhone Settings, then North.</p>
        <div className="divide-y divide-[#d9dde5] border-y border-[#d9dde5]">
          {PERMISSIONS.map((p) => (
            <div key={p.name} className="grid gap-1 py-3 sm:grid-cols-[9.5rem_1fr] sm:gap-4">
              <div className="font-semibold text-[#1a2b4a]">{p.name}</div>
              <div>
                {p.why} <span className="text-[#51607a]">Asked: {p.when}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="How long we keep it">
        <p>
          North keeps data while your company&apos;s account is open. It does not yet delete old records on a schedule,
          and that includes Nort conversations, error logs, bug-report screenshots, clock-in locations, signatures and
          uploaded files.
        </p>
        <p>
          You can ask us to delete your account and data at any time. <a href="/support#delete">Here Is How.</a>
        </p>
      </Section>

      <Section title="Your choices">
        <ul>
          <li>Turn location, camera, microphone, photos or notifications off in iPhone Settings. The features that need them stop working; the rest of North keeps going.</li>
          <li>Leave Google Calendar unconnected, or disconnect it.</li>
          <li>Ask us for a copy of your data, a correction, or deletion at <a href={mailto("Privacy request")}>{SUPPORT_EMAIL}</a>.</li>
        </ul>
      </Section>

      <Section title="Children">
        <p>
          North is a work tool for adults. It is not meant for children under 13, and we don&apos;t knowingly collect their
          information. If you think a child&apos;s information is in North, write to us and we will delete it.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Data travels over encrypted connections (HTTPS) and is stored with Supabase. Each company&apos;s records are walled
          off from every other company&apos;s by rules in the database itself, not only by the app&apos;s screens. North is
          invite-only. No system is perfectly secure, and we can&apos;t promise yours never will be; if we learn of a breach
          that affects you, we will tell you.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>When this policy changes, we update this page and the date at the top.</p>
        <p>
          {OPERATOR_LINE} Questions: <a href={mailto("Privacy question")}>{SUPPORT_EMAIL}</a>.
        </p>
      </Section>
    </>
  );
}
