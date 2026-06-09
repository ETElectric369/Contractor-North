import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/tabs";
import { initials } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { OrgSettingsForm } from "./org-settings-form";
import { InviteManager } from "./invite-manager";
import { DocumentDesigner } from "./document-designer";
import { LogoUpload } from "./logo-upload";
import { LanguageToggle } from "./language-toggle";
import { DocumentSettings } from "./document-settings";
import { SchedulingSettings } from "./scheduling-settings";
import { PaymentMethods } from "./payment-methods";
import { AutomationSettings } from "./automation-settings";
import { TaxRatesManager } from "./tax-rates-manager";
import { translator } from "@/lib/i18n";
import { billingEnabled } from "@/lib/stripe";
import { qboConfigured } from "@/lib/quickbooks";
import { trialDaysLeft } from "@/lib/subscription";
import { startCheckout, openPortal } from "./billing-actions";
import { disconnectQuickbooks } from "./actions";
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

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string; billing_error?: string; qbo?: string }>;
}) {
  const { billing, billing_error, qbo } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: me } = await supabase.from("profiles").select("*").eq("id", user?.id ?? "").single();
  const profile = me as Profile | null;
  const isAdmin = profile?.role === "owner" || profile?.role === "admin";
  const t = translator(profile?.language);

  const [{ data: org }, { data: team }, { data: invites }, { data: taxRates }, { data: pricingLevels }] = await Promise.all([
    profile?.org_id
      ? supabase.from("organizations").select("*").eq("id", profile.org_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("profiles").select("*").order("full_name"),
    isAdmin
      ? supabase.from("invitations").select("*").order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    supabase.from("tax_rates").select("id, name, rate, is_default").order("created_at"),
    supabase.from("pricing_levels").select("id, name, markup_pct, is_default").order("created_at"),
  ]);

  const members = (team ?? []) as Profile[];
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const settings = getOrgSettings((org as any)?.settings);

  const { data: qboConn } = isAdmin
    ? await supabase.from("accounting_connections").select("realm_id, connected_at").maybeSingle()
    : { data: null };

  const profileTab = {
    id: "profile",
    label: "Profile",
    content: (
      <Section title="Your profile">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand text-lg font-semibold text-white">
            {initials(profile?.full_name)}
          </div>
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
      </Section>
    ),
  };

  const teamTab = {
    id: "team",
    label: "Team",
    content: (
      <div className="space-y-6">
        {isAdmin && (
          <Section title="Invite team members">
            <InviteManager invites={(invites as any) ?? []} siteUrl={siteUrl} />
          </Section>
        )}
        <Card>
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Team ({members.length})</h3>
          </div>
          <ul className="divide-y divide-slate-100">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
                  {initials(m.full_name)}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-900">{m.full_name ?? "—"}</div>
                  <div className="text-xs text-slate-400">{m.email}</div>
                </div>
                {!m.active && <Badge tone="red">inactive</Badge>}
                <Badge tone={roleTone[m.role]}>{m.role}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    ),
  };

  const adminTabs = org
    ? [
        {
          id: "company",
          label: "Company",
          content: <Section title="Company details"><OrgSettingsForm org={org as Organization} /></Section>,
        },
        {
          id: "financial",
          label: "Financial",
          content: <Section title="Tax, pricing & financial defaults"><TaxRatesManager taxRates={(taxRates ?? []) as any} pricingLevels={(pricingLevels ?? []) as any} settings={settings} /></Section>,
        },
        {
          id: "documents",
          label: "Documents",
          content: (
            <div className="space-y-6">
              <Section title="Quote & invoice defaults"><DocumentSettings settings={settings} /></Section>
              <Section title="Company logo">
                <LogoUpload orgId={(org as Organization).id} current={(org as Organization).logo_url} />
              </Section>
              <Section title="Document designer">
                <DocumentDesigner
                  templates={(org as Organization).doc_templates || {}}
                  fallback={(org as Organization).doc_template || "classic"}
                  brand={(org as Organization).brand_color || "#0b57c4"}
                />
              </Section>
            </div>
          ),
        },
        {
          id: "scheduling",
          label: "Scheduling",
          content: <Section title="Scheduler & timesheets"><SchedulingSettings settings={settings} /></Section>,
        },
        {
          id: "payments",
          label: "Payments",
          content: <Section title="Payment methods"><PaymentMethods settings={settings} /></Section>,
        },
        {
          id: "automation",
          label: "Automation",
          content: <Section title="Reminders & follow-ups"><AutomationSettings settings={settings} /></Section>,
        },
        {
          id: "integrations",
          label: "Integrations",
          content: (
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
          ),
        },
        {
          id: "plan",
          label: "Plan & Billing",
          content: (
            <Section title="Subscription">
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
                    <form action={openPortal}><Button variant="outline">Manage billing</Button></form>
                  ) : (
                    <form action={startCheckout}><Button>Subscribe</Button></form>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-sm text-slate-400">Billing isn't configured yet. Add your Stripe keys (STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET) to enable subscriptions.</p>
              )}
            </Section>
          ),
        },
      ]
    : [];

  const tabs = [...adminTabs, teamTab, profileTab];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" description="Configure every part of your business." />
      <Tabs tabs={tabs} />
    </div>
  );
}
