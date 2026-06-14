import "server-only";

/** True when an email provider (Resend) is configured. */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Send a transactional email via Resend. Returns { ok, error }.
 * No-ops (logs) until RESEND_API_KEY is set, so the feature is safe pre-setup.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Contractor North <onboarding@resend.dev>";
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

/** Build a simple branded HTML document email for a quote or invoice. */
export function renderDocEmail(input: {
  docType: "Quote" | "Estimate" | "Invoice";
  number: string;
  company: { name: string; brand: string; phone?: string | null; email?: string | null };
  customerName: string;
  title?: string | null;
  items: { description: string; quantity: number; unit?: string | null; price: number; total: number }[];
  subtotal: number;
  tax: number;
  total: number;
  balance?: number | null;
  notes?: string | null;
  link?: string;
}): string {
  const rows = input.items
    .map(
      (it) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee;color:#334155">${escape(it.description)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#64748b">${it.quantity} ${escape(it.unit ?? "")}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#64748b">${money(it.price)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#0f172a;font-weight:600">${money(it.total)}</td>
      </tr>`,
    )
    .join("");

  const balanceRow =
    input.balance != null
      ? `<tr><td colspan="3" style="text-align:right;padding:4px 0;color:#0f172a;font-weight:700">Balance due</td><td style="text-align:right;padding:4px 0;color:#0f172a;font-weight:700">${money(input.balance)}</td></tr>`
      : "";

  return `
  <div style="font-family:ui-sans-serif,system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;color:#0f172a">
    <div style="border-bottom:3px solid ${input.company.brand};padding-bottom:12px;margin-bottom:16px">
      <div style="font-size:20px;font-weight:700">${escape(input.company.name)}</div>
      <div style="font-size:12px;color:#64748b">${[input.company.phone, input.company.email].filter(Boolean).map(escape).join(" · ")}</div>
    </div>
    <p style="font-size:14px">Hi ${escape(input.customerName)},</p>
    <p style="font-size:14px;color:#475569">Please find your ${input.docType.toLowerCase()} <strong>${escape(input.number)}</strong>${input.title ? ` — ${escape(input.title)}` : ""} below.</p>
    ${input.link ? `<p style="margin:14px 0"><a href="${input.link}" style="display:inline-block;background:${input.company.brand};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">View ${input.docType.toLowerCase()} online</a></p>` : ""}
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
      <thead>
        <tr>
          <th style="text-align:left;padding-bottom:6px;border-bottom:2px solid #cbd5e1;color:#64748b;font-size:11px;text-transform:uppercase">Description</th>
          <th style="text-align:right;padding-bottom:6px;border-bottom:2px solid #cbd5e1;color:#64748b;font-size:11px;text-transform:uppercase">Qty</th>
          <th style="text-align:right;padding-bottom:6px;border-bottom:2px solid #cbd5e1;color:#64748b;font-size:11px;text-transform:uppercase">Price</th>
          <th style="text-align:right;padding-bottom:6px;border-bottom:2px solid #cbd5e1;color:#64748b;font-size:11px;text-transform:uppercase">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="3" style="text-align:right;padding:8px 0 2px;color:#64748b">Subtotal</td><td style="text-align:right;padding:8px 0 2px;color:#64748b">${money(input.subtotal)}</td></tr>
        <tr><td colspan="3" style="text-align:right;padding:2px 0;color:#64748b">Tax</td><td style="text-align:right;padding:2px 0;color:#64748b">${money(input.tax)}</td></tr>
        <tr><td colspan="3" style="text-align:right;padding:4px 0;color:#0f172a;font-weight:700;border-top:1px solid #cbd5e1">Total</td><td style="text-align:right;padding:4px 0;color:#0f172a;font-weight:700;border-top:1px solid #cbd5e1">${money(input.total)}</td></tr>
        ${balanceRow}
      </tfoot>
    </table>
    ${input.notes ? `<p style="font-size:13px;color:#475569;margin-top:16px"><strong>Notes:</strong><br/>${escape(input.notes).replace(/\n/g, "<br/>")}</p>` : ""}
    <p style="font-size:13px;color:#64748b;margin-top:24px">Thank you for your business.<br/>${escape(input.company.name)}</p>
  </div>`;
}

function escape(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
