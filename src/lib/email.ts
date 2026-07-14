import "server-only";

/**
 * Send a transactional email via Resend. Returns { ok, error }.
 * No-ops (logs) until RESEND_API_KEY is set, so the feature is safe pre-setup.
 */
/** The owner's email to BCC on customer mail when "copy me on emails" is on. */
export function ownerBcc(copyOwner: boolean, ownerEmail?: string | null): string | undefined {
  return copyOwner && ownerEmail ? ownerEmail : undefined;
}

/** The bare address out of an "Name <addr>" (or a bare-address) EMAIL_FROM. */
function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

/** A display name safe to sit in a From header — strip quote/angle/CR-LF chars that could
 *  break the header or inject a second address, cap the length, fall back if it empties out. */
function sanitizeFromName(name: string): string {
  return String(name).replace(/["<>\r\n]/g, "").trim().slice(0, 78) || "Contractor North";
}

/**
 * Build the From header for an org's outbound mail. `fromName` (the sending org's business
 * name) becomes the visible sender over the SAME verified address from `base` (EMAIL_FROM) —
 * so each tenant's mail reads as their own business, while DKIM alignment / deliverability
 * (which key off the address's domain, not the display name) stay intact. No `fromName` →
 * `base` verbatim. Exported for testing the header-injection sanitization.
 */
export function composeFrom(base: string, fromName?: string | null): string {
  if (!fromName) return base;
  return `"${sanitizeFromName(fromName)}" <${addressOf(base)}>`;
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  bcc?: string | string[];
  /** The SENDING ORG's name. When set, it becomes the visible sender ("Tahoe Deck <…>") so
   *  each tenant's mail is branded as THEIR business, not the one platform default. Only the
   *  display name changes — the verified sending ADDRESS (and therefore DKIM alignment /
   *  deliverability) is untouched. Absent → the raw EMAIL_FROM, verbatim. */
  fromName?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  const base = process.env.EMAIL_FROM || "Contractor North <onboarding@resend.dev>";
  const from = composeFrom(base, input.fromName);
  if (!key) {
    console.log(`[email] (not configured) would send "${input.subject}" to ${input.to}`);
    return { ok: false, error: "Email isn't set up yet. Add RESEND_API_KEY to enable it." };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      ...(input.bcc && input.bcc.length ? { bcc: input.bcc } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Email failed: ${res.status} ${text}`.slice(0, 200) };
  }
  return { ok: true };
}

/** Money formatter usable in email HTML (no React/Intl context needed). */
export function money(n: number | null | undefined): string {
  return `$${(Number(n ?? 0)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Invoice notification email — a basic greeting + the balance + a button to the one
 * canonical invoice document (the /i link, which is viewable, printable to the same
 * PDF, and payable), plus a link to the customer portal. Deliberately does NOT
 * re-render the line items: the document lives at the link, so the email can never
 * drift from the print/portal view (that was the recurring "print ≠ email" bug).
 */
export function renderInvoiceNoticeEmail(input: {
  company: { name: string; brand: string; tagline?: string | null; phone?: string | null; email?: string | null };
  /** The grouped letterhead (same companyBlock() the printed document uses) — address,
   *  then phone/email behind a brand accent rule, then the license. Keeps email == print. */
  letterhead?: { address: string[]; contact: string[]; license: string | null };
  customerName: string;
  number: string;
  title?: string | null;
  balance: number;
  invoiceLink: string;
  portalLink?: string;
}): string {
  const c = safeColor(input.company.brand);
  const due = input.balance > 0;
  const lh = input.letterhead;
  const line = (s: string, style: string) => `<div style="font-size:12px;${style}">${escape(s)}</div>`;
  const contact = lh
    ? `${lh.address.length ? `<div style="line-height:1.5">${lh.address.map((l) => line(l, "color:#64748b")).join("")}</div>` : ""}` +
      `${lh.contact.length || lh.license ? `<div style="border-left:2px solid ${c};padding-left:9px;margin-top:7px;line-height:1.5">${lh.contact.map((l) => line(l, "color:#475569")).join("")}${lh.license ? line(lh.license, "color:#0f172a;font-weight:600") : ""}</div>` : ""}`
    : `<div style="font-size:12px;color:#64748b">${[input.company.phone, input.company.email].filter(Boolean).map(escape).join(" · ")}</div>`;
  return `
  <div style="font-family:ui-sans-serif,system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <div style="border-bottom:3px solid ${c};padding-bottom:12px;margin-bottom:16px">
      <div style="font-size:20px;font-weight:700">${escape(input.company.name)}</div>
      ${input.company.tagline ? `<div style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#94a3b8;margin-bottom:6px">${escape(input.company.tagline)}</div>` : `<div style="height:6px"></div>`}
      ${contact}
    </div>
    <p style="font-size:14px;margin:0 0 8px">Hi ${escape(input.customerName)},</p>
    <p style="font-size:14px;color:#475569;margin:0">Your invoice <strong>${escape(input.number)}</strong>${input.title ? ` — ${escape(input.title)}` : ""} is ready${due ? `. Balance due: <strong style="color:#0f172a">${money(input.balance)}</strong>.` : " — paid in full. Thank you!"}</p>
    <p style="margin:18px 0"><a href="${input.invoiceLink}" style="display:inline-block;background:${c};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600">${due ? `View &amp; pay ${money(input.balance)}` : "View invoice"}</a></p>
    ${input.portalLink ? `<p style="font-size:13px;color:#475569;margin:0">Or see all your invoices, quotes, and documents — and print a PDF — in <a href="${input.portalLink}" style="color:${c};font-weight:600">your customer portal</a>.</p>` : ""}
    <p style="font-size:13px;color:#64748b;margin-top:24px">Thank you for your business,<br/>${escape(input.company.name)}</p>
  </div>`;
}

/**
 * Quote / Estimate notification email — a greeting + the number/title/total + a
 * button to the one canonical public quote document (the /q link, which is
 * viewable, printable to the same PDF, and acceptable). Deliberately does NOT
 * re-render the line items: the document lives at the link, so the email can
 * never drift from the print/portal view (the recurring "print ≠ email" bug,
 * the exact decision made for renderInvoiceNoticeEmail).
 */
export function renderQuoteNoticeEmail(input: {
  docType: "Quote" | "Estimate";
  company: { name: string; brand: string; tagline?: string | null; phone?: string | null; email?: string | null };
  /** The grouped letterhead (same companyBlock() the printed document uses) — address,
   *  then phone/email behind a brand accent rule, then the license. Keeps email == print. */
  letterhead?: { address: string[]; contact: string[]; license: string | null };
  customerName: string;
  number: string;
  title?: string | null;
  total: number;
  quoteLink: string;
  portalLink?: string;
}): string {
  const c = safeColor(input.company.brand);
  const lh = input.letterhead;
  const noun = input.docType.toLowerCase();
  const line = (s: string, style: string) => `<div style="font-size:12px;${style}">${escape(s)}</div>`;
  const contact = lh
    ? `${lh.address.length ? `<div style="line-height:1.5">${lh.address.map((l) => line(l, "color:#64748b")).join("")}</div>` : ""}` +
      `${lh.contact.length || lh.license ? `<div style="border-left:2px solid ${c};padding-left:9px;margin-top:7px;line-height:1.5">${lh.contact.map((l) => line(l, "color:#475569")).join("")}${lh.license ? line(lh.license, "color:#0f172a;font-weight:600") : ""}</div>` : ""}`
    : `<div style="font-size:12px;color:#64748b">${[input.company.phone, input.company.email].filter(Boolean).map(escape).join(" · ")}</div>`;
  return `
  <div style="font-family:ui-sans-serif,system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <div style="border-bottom:3px solid ${c};padding-bottom:12px;margin-bottom:16px">
      <div style="font-size:20px;font-weight:700">${escape(input.company.name)}</div>
      ${input.company.tagline ? `<div style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#94a3b8;margin-bottom:6px">${escape(input.company.tagline)}</div>` : `<div style="height:6px"></div>`}
      ${contact}
    </div>
    <p style="font-size:14px;margin:0 0 8px">Hi ${escape(input.customerName)},</p>
    <p style="font-size:14px;color:#475569;margin:0">Your ${noun} <strong>${escape(input.number)}</strong>${input.title ? ` — ${escape(input.title)}` : ""} is ready. Total: <strong style="color:#0f172a">${money(input.total)}</strong>.</p>
    <p style="margin:18px 0"><a href="${input.quoteLink}" style="display:inline-block;background:${c};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600">View &amp; accept ${noun}</a></p>
    ${input.portalLink ? `<p style="font-size:13px;color:#475569;margin:0">Or see all your quotes, invoices, and documents — and print a PDF — in <a href="${input.portalLink}" style="color:${c};font-weight:600">your customer portal</a>.</p>` : ""}
    <p style="font-size:13px;color:#64748b;margin-top:24px">Thank you for the opportunity to earn your business,<br/>${escape(input.company.name)}</p>
  </div>`;
}

/** A light branded "nudge" email — payment reminder, quote follow-up, appointment
 *  reminder. Header + heading + a short message + optional button. Same brand header
 *  as the notice emails so reminders look like the rest of the contractor's mail. */
export function renderReminderEmail(input: {
  company: { name: string; brand: string; phone?: string | null; email?: string | null };
  customerName: string;
  heading: string;
  message: string;
  cta?: { label: string; link: string };
}): string {
  const c = safeColor(input.company.brand);
  return `
  <div style="font-family:ui-sans-serif,system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <div style="border-bottom:3px solid ${c};padding-bottom:12px;margin-bottom:16px">
      <div style="font-size:20px;font-weight:700">${escape(input.company.name)}</div>
      <div style="font-size:12px;color:#64748b">${[input.company.phone, input.company.email].filter(Boolean).map(escape).join(" · ")}</div>
    </div>
    <p style="font-size:16px;font-weight:600;margin:0 0 12px">${escape(input.heading)}</p>
    <p style="font-size:14px;margin:0 0 8px">Hi ${escape(input.customerName)},</p>
    <p style="font-size:14px;color:#475569;margin:0">${escape(input.message)}</p>
    ${input.cta ? `<p style="margin:18px 0"><a href="${input.cta.link}" style="display:inline-block;background:${c};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">${escape(input.cta.label)}</a></p>` : ""}
    <p style="font-size:13px;color:#64748b;margin-top:24px">Thank you,<br/>${escape(input.company.name)}</p>
  </div>`;
}

/** A brand color is injected raw into email style attributes — constrain it to a
 *  valid hex so a malformed/hostile settings value can't break out of the attribute. */
function safeColor(c: string | null | undefined): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(c ?? "")) ? String(c) : "#0b57c4";
}

function escape(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
