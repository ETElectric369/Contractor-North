import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { User, Building2, Wallet, CalendarDays, Plug } from "lucide-react";
import { SettingsSubnav } from "./settings-subnav";
import { getOrgSettings, accentHex } from "@/lib/org-settings";
import { OrgSettingsForm } from "./org-settings-form";
import { DocumentDesigner } from "./document-designer";
import { LogoUpload } from "./logo-upload";
import { LanguageToggle } from "./language-toggle";
import { MapsProviderToggle } from "./maps-provider-toggle";
import { PushSettings } from "./push-settings";
import { DocumentSettings } from "./document-settings";
import { NumberingSettings } from "./numbering-settings";
import { SchedulingSettings } from "./scheduling-settings";
import { PaymentMethods } from "./payment-methods";
import { AutomationSettings } from "./automation-settings";
import { TaxRatesManager } from "./tax-rates-manager";
import { JobCodesManager } from "./job-codes-manager";
import { SplashSettings } from "./splash-settings";
import { WebsiteSettings } from "./website-settings";
import { PortfolioManager } from "./portfolio-manager";
import { ReviewsManager } from "./reviews-manager";
import { AiStatus } from "./ai-status";
import { QuotePlaybookForm } from "./quote-playbook-form";
import { AvatarUpload } from "./avatar-upload";
import { CodeTemplatesManager } from "./code-templates-manager";
import { PasskeyManager } from "./passkey-manager";
import { listPasskeys } from "./passkey-actions";
import { gcalConfigured } from "@/lib/google-calendar";
import { GcalCard } from "./gcal-card";
import QRCode from "qrcode";
import { translator } from "@/lib/i18n";
import { billingEnabled } from "@/lib/stripe";
import { qboConfigured } from "@/lib/quickbooks";
import { trialDaysLeft } from "@/lib/subscription";
import { startCheckout, openPortal } from "./billing-actions";
import { disconnectQuickbooks, getDocCounters } from "./actions";
import type { Organization, Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

const roleTone: Record<string, "purple" | "indigo" | "blue" | "slate"> = {
  owner: "purple",
  admin: "indigo",
  office: "blue",
  tech: "slate",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-5">
        <h3 className="mb-4 text-sm font-semibold text-slate-900">{title}</h3>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * SETTINGS — collapsed to four MINDSET clusters after Team left for its own /team page
 * (settings doctrine): "You" (everything personal), "Company" (who we are + how leads
 * reach us), "Money & docs" (dollars, tax/pricing, document numbering & design, QBO/
 * Stripe), and "Integrations" (the AI + calendar connectors). Techs get only "You".
 * urlSync (?tab=) stays live; role-gating intact — the admin clusters are staff-only.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string; billing_error?: string; qbo?: string; gcal?: string; tab?: string }>;
}) {
  const { billing, billing_error, qbo, gcal, tab } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: me } = await supabase.from("profiles").select("*").eq("id", user?.id ?? "").single();
  const profile = me as Profile | null;
  const isAdmin = profile?.role === "owner" || profile?.role === "admin";
  // Office (Alexa's control plane: Numbering, Scheduling & timesheets, Automation)
  // keeps the org-settings cluster; only techs are gated out of it.
  const isStaff = isAdmin || profile?.role === "office";
  const t = translator(profile?.language);

  const [{ data: org }, { data: taxRates }, { data: pricingLevels }, { data: codeTemplates }, { data: jobCodes }] = await Promise.all([
    profile?.org_id
      ? supabase.from("organizations").select("*").eq("id", profile.org_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
    supabase.from("pricing_levels").select("id, name, markup_pct, is_default").order("created_at"),
    supabase.from("job_code_templates").select("id, name, codes").order("name"),
    supabase.from("job_codes").select("id, code, description, billable, active").order("code"),
  ]);

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const sitesDomain = process.env.SITES_DOMAIN || "contractornorth.com";
  const settings = getOrgSettings((org as any)?.settings);
  const docCounters = await getDocCounters(); // null until migration 0088 is applied

  // The scheduler's crew picker still needs the team names (read-only here — editing
  // the roster itself lives on /team now).
  const { data: crew } = await supabase.from("profiles").select("id, full_name, role").order("full_name");
  const members = (crew ?? []) as Pick<Profile, "id" | "full_name" | "role">[];

  const { data: qboConn } = isAdmin
    ? await supabase.from("accounting_connections").select("realm_id, connected_at").maybeSingle()
    : { data: null };
  const { data: gcalConn } = isAdmin
    ? await supabase.from("calendar_connections").select("id").eq("provider", "google").maybeSingle()
    : { data: null };

  // QR for the public inquiry page (trucks, signs, business cards).
  const inquiryUrl = process.env.SPLASH_DOMAIN
    ? `https://${process.env.SPLASH_DOMAIN}`
    : `${siteUrl || "https://contractor-north.vercel.app"}/inquire/${profile?.org_id}`;
  const inquiryQr = org
    ? await QRCode.toDataURL(inquiryUrl, { margin: 1, width: 280, color: { dark: "#0f172a" } })
    : null;

  const passkeys = await listPasskeys();

  // ── "You" — everything personal (profile, notifications, language, security). ─────────
  const youTab = {
    id: "you",
    label: "You",
    icon: User,
    content: (
      <div className="space-y-6">
        <Section title="Your profile">
          <div className="flex flex-wrap items-center gap-5">
            <AvatarUpload
              userId={profile?.id ?? ""}
              orgId={profile?.org_id ?? ""}
              name={profile?.full_name ?? null}
              current={profile?.avatar_url ?? null}
            />
            <div>
              <div className="text-base font-medium text-slate-900">{profile?.full_name ?? "—"}</div>
              <div className="text-sm text-slate-500">{profile?.email}</div>
              <Badge tone={roleTone[profile?.role ?? "tech"]} className="mt-1">{profile?.role}</Badge>
            </div>
          </div>
          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="text-sm font-medium text-slate-700">{t("s_language")}</div>
            <div className="mb-2 text-xs text-slate-400">{t("s_languageDesc")}</div>
            <LanguageToggle current={profile?.language ?? "en"} />
          </div>
          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="mb-1 text-sm font-medium text-slate-700">Navigation app</div>
            <MapsProviderToggle />
          </div>
          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="mb-2 text-sm font-medium text-slate-700">Sign-in &amp; security</div>
            <PasskeyManager passkeys={passkeys} />
          </div>
        </Section>
        <Section title="Push notifications">
          <PushSettings initialPrefs={((profile as any)?.push_prefs ?? {}) as Record<string, boolean>} />
        </Section>
      </div>
    ),
  };

  // ── The admin clusters (staff only). ─────────────────────────────────────────────────
  const adminTabs = org && isStaff
    ? [
        // "Company" — who we are + how leads reach us.
        {
          id: "company",
          label: "Company",
          icon: Building2,
          content: (
            <div className="space-y-6">
              <Section title="Your website">
                <WebsiteSettings settings={settings} siteUrl={siteUrl} sitesDomain={sitesDomain} />
              </Section>
              <Section title="Portfolio photos">
                <PortfolioManager orgId={(org as Organization).id} initial={settings.portfolio ?? []} />
              </Section>
              <Section title="Reviews">
                <ReviewsManager initial={settings.reviews ?? []} />
              </Section>
              <Section title="Company details"><OrgSettingsForm org={org as Organization} /></Section>
              <Section title="Company logo">
                <LogoUpload orgId={(org as Organization).id} current={(org as Organization).logo_url} />
              </Section>
              <Section title="Public lead link">
                <p className="mb-2 text-sm text-slate-500">
                  Post this link online (or text/email it). Anyone who submits the form becomes a new lead in <strong>Leads</strong> — no login needed for them.
                </p>
                <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">
                  {(siteUrl || "https://contractor-north.vercel.app")}/inquire/{(org as Organization).id}
                </code>
                <div className="mt-4 flex flex-wrap items-center gap-4">
                  {inquiryQr && (
                    // Tappable, not just scannable: on a screen (texted screenshot, the digital card)
                    // nobody can scan the QR they're looking at — tapping it opens the same page.
                    <a href={inquiryUrl} target="_blank" rel="noopener noreferrer" title="Open the inquiry page">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={inquiryQr} alt="Inquiry page QR code — tap to open" className="h-28 w-28 rounded-lg border border-slate-200" />
                    </a>
                  )}
                  <div className="space-y-2 text-sm">
                    <p className="text-slate-500">
                      The QR code opens the same page — put it on trucks, yard signs, and cards.
                      {inquiryQr && (
                        <>
                          {" "}
                          <a href={inquiryQr} download="inquiry-qr.png" className="font-medium text-brand hover:underline">
                            Download PNG
                          </a>
                        </>
                      )}
                    </p>
                    <a
                      href="/print/business-card"
                      className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
                    >
                      Print Business Cards →
                    </a>
                  </div>
                </div>
              </Section>
              <Section title="Splash page"><SplashSettings settings={settings} /></Section>
            </div>
          ),
        },
        // "Money & docs" — dollars, tax/pricing, document numbering & design, QBO/Stripe.
        {
          id: "money",
          label: "Money & Docs",
          icon: Wallet,
          content: (
            <div className="space-y-6">
              <Section title="Tax, pricing & financial defaults"><TaxRatesManager taxRates={(taxRates ?? []) as any} pricingLevels={(pricingLevels ?? []) as any} settings={settings} /></Section>
              <Section title="How we quote (AI playbook)"><QuotePlaybookForm settings={settings} /></Section>
              <Section title="Payment methods"><PaymentMethods settings={settings} /></Section>
              <Section title="Estimate & invoice defaults"><DocumentSettings settings={settings} /></Section>
              <Section title="Numbering">
                <NumberingSettings prefixes={settings.doc_prefixes} counters={docCounters} />
              </Section>
              <Section title="Document designer">
                <DocumentDesigner
                  templates={(org as Organization).doc_templates || {}}
                  fallback={(org as Organization).doc_template || "classic"}
                  brand={accentHex(settings.glass_tint)}
                />
              </Section>
              <Section title="QuickBooks">
                {qbo === "connected" && (
                  <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">Connected to QuickBooks Online.</div>
                )}
                {(qbo === "error" || qbo === "denied") && (
                  <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Could not connect to QuickBooks. Please try again.</div>
                )}
                {!qboConfigured() ? (
                  <p className="text-sm text-slate-400">Not configured yet. Add QBO_CLIENT_ID, QBO_CLIENT_SECRET, and QBO_ENVIRONMENT to enable syncing.</p>
                ) : qboConn?.realm_id ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge tone="green">Connected</Badge>
                    <span className="text-sm text-slate-500">Send invoices to QuickBooks from any invoice page.</span>
                    <form action={async () => { "use server"; await disconnectQuickbooks(); }}>
                      <Button variant="outline">Disconnect</Button>
                    </form>
                  </div>
                ) : (
                  <div>
                    <a href="/api/quickbooks/connect" className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">Connect QuickBooks</a>
                    <p className="mt-2 text-xs text-slate-400">Sync customers and invoices to QuickBooks Online.</p>
                  </div>
                )}
              </Section>
              <Section title="Plan & subscription">
                {billing === "success" && (
                  <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">Subscription active — thank you!</div>
                )}
                {billing_error && (
                  <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{billing_error}</div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={(org as Organization).subscription_status === "active" ? "green" : "amber"}>
                    {(org as Organization).subscription_status}
                  </Badge>
                  <span className="text-sm text-slate-600">Plan: {(org as Organization).plan}</span>
                  {(org as Organization).subscription_status === "trialing" && (
                    <span className="text-sm text-slate-500">· {trialDaysLeft(org as Organization)} days left in trial</span>
                  )}
                </div>
                {billingEnabled ? (
                  <div className="mt-4 flex gap-2">
                    {(org as Organization).subscription_status === "active" ? (
                      <form action={openPortal}><Button variant="outline">Manage Billing</Button></form>
                    ) : (
                      <form action={startCheckout}><Button>Subscribe</Button></form>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-slate-400">Billing isn&apos;t configured yet. Add your Stripe keys (STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET) to enable subscriptions.</p>
                )}
              </Section>
            </div>
          ),
        },
        // "Scheduling" — Alexa's control plane (scheduler + timesheets + job codes).
        {
          id: "scheduling",
          label: "Scheduling",
          icon: CalendarDays,
          content: (
            <div className="space-y-6">
              <Section title="Scheduler & timesheets">
                <SchedulingSettings
                  settings={settings}
                  employees={members.map((m) => ({ id: m.id, full_name: m.full_name }))}
                  ownerName={members.find((m) => m.role === "owner")?.full_name ?? undefined}
                />
              </Section>
              <Section title="Job codes">
                <JobCodesManager
                  jobCodes={(jobCodes ?? []) as { id: string; code: string; description: string; billable: boolean; active: boolean }[]}
                />
              </Section>
              <Section title="Job-code templates">
                <CodeTemplatesManager
                  templates={(codeTemplates ?? []) as { id: string; name: string; codes: string[] }[]}
                  codes={((jobCodes ?? []) as { code: string; description: string; active: boolean }[]).filter((c) => c.active).map((c) => ({ code: c.code, description: c.description }))}
                />
              </Section>
              <Section title="Reminders & follow-ups"><AutomationSettings settings={settings} /></Section>
            </div>
          ),
        },
        // "Integrations" — the AI + calendar connectors.
        {
          id: "integrations",
          label: "Integrations",
          icon: Plug,
          content: (
            <div className="space-y-6">
              <Section title="AI assistant">
                <AiStatus
                  configured={!!process.env.ANTHROPIC_API_KEY}
                  model={process.env.ANTHROPIC_MODEL || "claude-opus-4-8"}
                />
              </Section>
              <Section title="Google Calendar">
                <GcalCard configured={gcalConfigured()} connected={!!gcalConn} flash={gcal} />
              </Section>
            </div>
          ),
        },
      ]
    : [];

  // "You" leads for techs (their only cluster); for staff it follows the admin clusters —
  // the set-once org config leads, personal settings sit at the end (frequency law). This
  // order also fixes the default cluster: the first entry is what ?tab= falls back to.
  const clusters = isStaff ? [...adminTabs, youTab] : [youTab];

  // ROUTE-DRIVEN (not client <Tabs>): the left side-tab (settings-subnav) drives which
  // cluster shows via ?tab=<id>, so its own side-tab can replace the Office list that was
  // cluttering /settings (cn-v331). Resolve the active cluster from the ?tab= param, default
  // to the first role-appropriate cluster (staff → "company", tech → "you"), exactly the old
  // <Tabs urlSync> default (tabs[0]). An unknown/gated tab falls back to that default too.
  const active = clusters.find((c) => c.id === tab) ?? clusters[0];
  // The nav needs only id/label/icon per cluster — the panels render server-side below.
  const navClusters = clusters.map((c) => ({ id: c.id, label: c.label, icon: c.icon }));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" description="Configure every part of your business." />
      <SettingsSubnav clusters={navClusters} activeTab={active.id} />
      <div>{active.content}</div>
    </div>
  );
}
