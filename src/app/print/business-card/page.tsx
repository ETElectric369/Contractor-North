import Link from "next/link";
import { ArrowLeft, Phone, Mail, Globe } from "lucide-react";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { getOrgSettings } from "@/lib/org-settings";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Printable business cards: 8-up on letter for cutting, QR → inquiry page. */
export default async function BusinessCardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ data: me }, { data: org }] = await Promise.all([
    supabase.from("profiles").select("full_name, phone, email, role").eq("id", user?.id ?? "").maybeSingle(),
    supabase.from("organizations").select("*").limit(1).maybeSingle(),
  ]);
  const o = org as Organization | null;
  const settings = getOrgSettings((o as any)?.settings);

  const site = process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app";
  const inquiryUrl = process.env.SPLASH_DOMAIN
    ? `https://${process.env.SPLASH_DOMAIN}`
    : `${site}/inquire/${o?.id}`;
  const qr = await QRCode.toDataURL(inquiryUrl, { margin: 1, width: 240, color: { dark: "#0f172a" } });

  // License/credential line from the splash credentials (first line).
  const license = settings.splash_credentials?.split("\n").find((l) => /lic|c-10|#/i.test(l)) ?? "";

  const card = (
    <div className="flex h-[2in] w-[3.5in] overflow-hidden rounded border border-slate-300 bg-white">
      <div className="flex flex-1 flex-col justify-between p-3">
        <div>
          <div className="text-[13px] font-bold leading-tight" style={{ color: o?.brand_color || "#0b57c4" }}>
            {o?.name ?? "Your Company"}
          </div>
          {license && <div className="text-[8px] text-slate-500">{license}</div>}
        </div>
        <div>
          <div className="text-[11px] font-semibold text-slate-900">{me?.full_name ?? ""}</div>
          <div className="text-[8px] capitalize text-slate-500">{me?.role === "owner" ? "Owner" : me?.role}</div>
        </div>
        <div className="space-y-0.5 text-[8px] text-slate-600">
          {(me?.phone || o?.phone) && (
            <div className="flex items-center gap-1"><Phone className="h-2.5 w-2.5" /> {me?.phone || o?.phone}</div>
          )}
          {(me?.email || o?.email) && (
            <div className="flex items-center gap-1"><Mail className="h-2.5 w-2.5" /> {me?.email || o?.email}</div>
          )}
          <div className="flex items-center gap-1"><Globe className="h-2.5 w-2.5" /> {inquiryUrl.replace(/^https?:\/\//, "")}</div>
        </div>
      </div>
      <div className="flex w-[1.15in] flex-col items-center justify-center gap-1 p-2" style={{ background: `${o?.brand_color || "#0b57c4"}10` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt="Request a quote QR" className="h-[0.95in] w-[0.95in]" />
        <div className="text-center text-[7px] font-medium leading-tight text-slate-600">Scan for a free quote</div>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="no-print mb-6 flex items-center justify-between">
        <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" /> Back to settings
        </Link>
        <PrintButton />
      </div>
      <p className="no-print mb-4 text-sm text-slate-500">
        Print on letter card stock and cut — 8 cards per sheet (3.5&quot; × 2&quot;). The QR code opens your
        public &quot;Request a quote&quot; page.
      </p>
      <div className="grid grid-cols-2 justify-items-center gap-x-2 gap-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i}>{card}</div>
        ))}
      </div>
    </div>
  );
}
