import type { Metadata } from "next";
import { PageHead, Section } from "../prose";
import { SITE_ORIGIN, SUPPORT_EMAIL, mailto } from "../site-facts";

export const metadata: Metadata = {
  title: "Support · Contractor North",
  description: "How to get help with North, what to send us, and how to delete your account and data.",
  alternates: { canonical: `${SITE_ORIGIN}/support` },
};

export default function NorthSupport() {
  return (
    <>
      <PageHead eyebrow="Support" first="Help with North." second="One address, and a person reads it." />

      <Section title="Get help">
        <p>
          Email <a href={mailto("Help with North")}>{SUPPORT_EMAIL}</a>. Tell us what happened and we will write back.
        </p>
        <p>
          Office staff who are signed in can also use the bug button in the app (<strong>Report a bug</strong>). It sends
          us the page you were on, your note and a screenshot of the screen.
        </p>
        <p>
          <strong>A contractor&apos;s customer?</strong> Questions about a quote, an invoice or a job are for the
          contractor who sent it. Contractor North makes the software; we can&apos;t change their prices or records.
        </p>
      </Section>

      <Section title="What to include">
        <ul>
          <li>The email address you sign in with, and your company&apos;s name.</li>
          <li>iPhone or computer, and the iOS or browser version.</li>
          <li>What you were doing, what you expected, and what happened instead.</li>
          <li>A screenshot, if you can take one.</li>
        </ul>
        <p>
          Never send a password or a full card number. We will never ask for either.
        </p>
      </Section>

      <Section title="Signing in">
        <p>
          Forgot your password? Tap <strong>Forgot Password?</strong> on the sign-in screen. North is invite-only, so a new
          account starts with an invite from your company. If your company doesn&apos;t use North yet,{" "}
          <a href={mailto("Invite request")}>Ask Us For An Invite</a>.
        </p>
      </Section>

      <Section id="delete" title="Delete your account and data">
        <p>
          Right now, account deletion is handled by email. Write to{" "}
          <a href={mailto("Delete my account")}>{SUPPORT_EMAIL}</a> from the address you sign in with, with the subject
          &ldquo;Delete my account&rdquo;. We reply to that address to confirm before anything is deleted, and again when
          it is done.
        </p>
        <ul>
          <li>
            <strong>If you use North for work,</strong> we close your sign-in and remove your personal details: the
            email you sign in with, your phone, photo and home address, and your phone&apos;s notification and passkey
            keys. The hours you worked and what you were paid are part of your employer&apos;s payroll records, so they
            stay with your employer, with your name on them. Our reply tells you exactly what stays.
          </li>
          <li>
            <strong>If you own a company account,</strong> we delete the company and its data: customers, jobs, quotes,
            invoices, time records, files and Nort conversations. Tell us first if you need a copy of anything.
          </li>
          <li>
            <strong>If you are a contractor&apos;s customer,</strong> the contractor decides what they keep about you, so ask
            them. You can also write to us.
          </li>
        </ul>
        <p>
          Owners and admins can remove a team member themselves: <strong>Team</strong>, then the member&apos;s menu. Someone
          who has never clocked in can be removed outright. Someone with time on record can be deactivated, which ends
          their sign-in and keeps their hours for payroll.
        </p>
        <p>
          Data already sent to the services that run North (see <a href="/privacy#shared">Privacy</a>) is kept under
          their own policies.
        </p>
      </Section>

      <Section title="Privacy">
        <p>
          What North collects, why, and who handles it: <a href="/privacy">Read The Privacy Policy</a>.
        </p>
      </Section>
    </>
  );
}
