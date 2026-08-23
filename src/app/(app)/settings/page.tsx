import { PROFILE_SAFE_COLS } from "@/lib/profile-columns";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import {
  User,
  Building2,
  Globe,
  Wallet,
  CalendarDays,
  Plug,
  Layers,
  ClipboardList,
  FileText,
  CreditCard,
  MessageSquare,
  Images,
} from "lucide-react";
import { tolerateMissingColumns } from "@/lib/inspection/schema";
import { parsePlaybook, playbookForForm } from "@/lib/playbook/parse";
import { PLAYBOOK_STARTERS } from "@/lib/playbook/starters";
import { PlaybookManager } from "./playbook-manager";
import { LessonOffer } from "@/components/tour/lesson-offer";
import { SettingsSubnav } from "./settings-subnav";
import { getOrgSettings, accentHex, orgPublicBaseUrl } from "@/lib/org-settings";
import { renderReadyBlocks } from "@/lib/public-pages";
import { OrgSettingsForm } from "./org-settings-form";
import { DocumentDesigner } from "./document-designer";
import { PriceListCard } from "./price-list-card";
import { UNIT_STARTS_WITH_LETTER } from "@/lib/pricing/import-damage";
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
import { HomepageCard } from "./homepage-card";
import { WebsiteSettings } from "./website-settings";
import { IntakeCard } from "./intake-card";
import { PortfolioManager } from "./portfolio-manager";
import { ReviewsManager } from "./reviews-manager";
import { PostsManager } from "./posts-manager";
import { PagesManager } from "./pages-manager";
import { CollaboratorsManager } from "./collaborators-manager";
import { AiStatus } from "./ai-status";
import { QuotePlaybookForm } from "./quote-playbook-form";
import { AvatarUpload } from "./avatar-upload";
import { CodeTemplatesManager } from "./code-templates-manager";
import { PasskeyManager } from "./passkey-manager";
import { NortTone } from "./nort-tone";
import { asRegister, clampHumor } from "@/lib/nort/tone";
import { listPasskeys } from "./passkey-actions";
import { gcalConfigured, connectionNeedsReauth } from "@/lib/google-calendar";
import { GcalCard } from "./gcal-card";
import QRCode from "qrcode";
import { translator } from "@/lib/i18n";
import { billingEnabled } from "@/lib/stripe";
import { qboConfigured } from "@/lib/quickbooks";
import { trialDaysLeft } from "@/lib/subscription";
import { startCheckout, openPortal, connectPayments, openPayoutsDashboard } from "./billing-actions";
import { connectStateFromOrg, connectStatusLabel, canAcceptPayments } from "@/lib/stripe-connect";
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

  const { data: me } = await supabase.from("profiles").select(PROFILE_SAFE_COLS).eq("id", user?.id ?? "").single();
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
    supabase.from("pricing_levels").select("id, name, markup_pct, labor_rate, is_default").order("created_at"),
    supabase.from("job_code_templates").select("id, name, codes").order("name"),
    supabase.from("job_codes").select("id, code, description, billable, active").order("code"),
  ]);

  // THE PRICE-LIST PANE'S NUMBERS — counts, never rows. head:true sends no body, so this stays
  // three cheap COUNT queries whatever the size of somebody's book.
  const [{ count: priceItemCount }, { count: priceUnpriced }, { count: priceNoMarkup }, { count: priceShifted }] =
    await Promise.all([
      supabase.from("price_list_items").select("id", { count: "exact", head: true }).eq("archived", false),
      supabase.from("price_list_items").select("id", { count: "exact", head: true }).eq("archived", false).lte("buy_price", 0),
      supabase.from("price_list_items").select("id", { count: "exact", head: true }).eq("archived", false).lte("markup_pct", 0),
      // Rows the old CSV parser shifted a column left — see lib/pricing/import-damage.ts. The
      // operator is `imatch`, checked against production (3 rows) rather than assumed: a PostgREST
      // rejection returns null and would render as a reassuring zero.
      supabase
        .from("price_list_items")
        .select("id", { count: "exact", head: true })
        .eq("archived", false)
        .not("unit", "imatch", UNIT_STARTS_WITH_LETTER),
    ]);

  // The public intake door (0185): on = exactly one form flagged is_public_intake. Read
  // tolerantly — a deploy can land before its migration, and this page must not 500 for that.
  let intakeOn = false;
  try {
    const { data: intakeForm } = await supabase
      .from("forms")
      .select("id")
      .eq("is_public_intake", true)
      .limit(1)
      .maybeSingle();
    intakeOn = !!intakeForm;
  } catch {
    /* pre-migration: the door simply reads as off */
  }
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const sitesDomain = process.env.SITES_DOMAIN || "contractornorth.com";
  const settings = getOrgSettings((org as any)?.settings);
  const docCounters = await getDocCounters(); // null until migration 0088 is applied

  // The scheduler's crew picker still needs the team names (read-only here — editing
  // the roster itself lives on /team now).
  const { data: crew } = await supabase.from("profiles").select("id, full_name, role").order("full_name");
  const members = (crew ?? []) as Pick<Profile, "id" | "full_name" | "role">[];

  // Site articles (the SEO content layer) — RLS scopes to the org; staff-only tab below.
  const { data: sitePosts } = isStaff
    ? await supabase
        .from("site_posts")
        .select("id, path, title, description, cover_url, body_html, published, published_at, seo_title")
        .order("published_at", { ascending: false })
    : { data: null };

  // External SEO/content collaborators invited to manage this org's articles (RLS: own org).
  const { data: siteCollaborators } = isStaff
    ? await supabase
        .from("site_collaborators")
        .select("id, invited_email, user_id, created_at")
        .order("created_at", { ascending: false })
    : { data: null };

  // Custom builder pages (the block/page builder) — RLS scopes to the org.
  const { data: rawSitePages } = isStaff
    ? await supabase
        .from("site_pages")
        .select("id, slug, title, description, blocks, published, nav_label, nav_order, seo_title")
        .order("nav_order", { ascending: true })
        .order("title", { ascending: true }) // same tiebreak as the public reads — list matches live nav
    : { data: null };
  const sitePages = (rawSitePages ?? []).map((p) => ({
    ...(p as Record<string, unknown>),
    // renderReadyBlocks (not just normalize) — the editor's Preview renders these client-side, so the
    // text sink must be sanitized even here, in case a hostile direct write skipped the save action.
    blocks: renderReadyBlocks((p as { blocks?: unknown }).blocks),
  }));

  const { data: qboConn } = isAdmin
    ? await supabase.from("accounting_connections").select("realm_id, connected_at").maybeSingle()
    : { data: null };
  // isStaff, not isAdmin (audit 6). The Connections cluster is gated on isStaff — which includes
  // office — so Alexa SEES the Google Calendar pane, but this read was admin-only, so `gcalConn`
  // came back null and the pane told her the org had no calendar connected and invited her to
  // connect HER OWN account over the owner's. Every other gcal surface already treats this as
  // staff-level: RLS is is_org_staff(), and listGoogleCalendars / saveSelectedCalendars /
  // syncGoogleNow all call requireStaff(). This was the one read that disagreed.
  //
  // qboConn above stays isAdmin ON PURPOSE — accounting_select really is owner/admin-only, so
  // widening it would produce an RLS-rejected read that renders as ordinary emptiness.
  const { data: gcalConn } = isStaff
    ? await supabase.from("calendar_connections").select("id").eq("provider", "google").maybeSingle()
    : { data: null };
  // Two-way sync columns (0132) — a SEPARATE best-effort read so a not-yet-migrated
  // DB degrades to defaults instead of hiding the whole connection.
  const { data: gcalSync } = gcalConn
    ? await supabase
        .from("calendar_connections")
        .select("selected_calendars, last_synced_at, sync_tokens")
        .eq("provider", "google")
        .maybeSingle()
    : { data: null };

  // QR + lead link for the public inquiry page (trucks, signs, business cards). Point at the org's
  // REAL public address (custom domain, else the free subdomain) — never the app's vercel.app URL,
  // which read as "dev-server" junk on the settings page and made the printed QR stale.
  const publicBase = settings.public_handle
    ? orgPublicBaseUrl(settings)
    : siteUrl || "https://contractor-north.vercel.app";
  const inquiryUrl = `${publicBase}/inquire/${profile?.org_id}`;
  const inquiryQr = org
    ? await QRCode.toDataURL(inquiryUrl, { margin: 1, width: 280, color: { dark: "#0f172a" } })
    : null;

  const passkeys = await listPasskeys();

  // THE PLAYBOOK — the questions this company's own inspector asks, and why each one exists.
  // Read tolerantly: `playbook` is 0179 and a deploy lands before its migration, and a select
  // naming a column that doesn't exist yet fails the whole query rather than degrading.
  //
  // THE WEBSITE'S QUESTIONS BELONG IN HERE TOO. This query said `.eq("is_inspection", true)` and
  // nothing else, so the PUBLIC INTAKE form — is_inspection false, is_public_intake true — was not
  // in the editor at all. Andrew (Vivian Builders, beta) spent a day writing eleven customer-facing
  // questions, could only find the walk-through to put them in, put them there, and then asked
  // whether his Wix embed code was broken. It wasn't: his questions were in the internal form and
  // the door was faithfully serving the other one. Meanwhile the Intake card told him in plain
  // English that "the questions live in the Customer intake form under Playbook" — a sentence this
  // select made false.
  //
  // `.or()` rather than dropping the filter: a form that is neither an inspection nor the intake
  // door (his Job Site Safety Checklist) is not a playbook and must stay out.
  const inspectionForms = isStaff
    ? await tolerateMissingColumns<
        { id: string; name: string; schema: unknown; playbook: unknown; is_public_intake: boolean | null }[]
      >(() =>
        supabase
          .from("forms")
          .select("id, name, schema, playbook, is_public_intake")
          .or("is_inspection.eq.true,is_public_intake.eq.true")
          .order("name"),
      )
    : null;
  const playbookForms = (inspectionForms ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    // Converted from the sheet when there is no playbook yet, so the editor always opens on the
    // real current questions rather than an empty page somebody has to guess at.
    needs: playbookForForm(f).needs,
    owned: parsePlaybook(f.playbook).needs.length > 0,
    /** True for the one form the public door serves — the picker says so out loud. */
    isWebsite: !!f.is_public_intake,
  }));

  // ── "You" — everything personal (profile, notifications, language, security). ─────────
  const youTab = {
    id: "you",
    label: "You",
    icon: User,
    content: (
      <div className="space-y-6">
        {/* HOW NORT TALKS TO YOU (0183) — under "You", not under the company, because register is
            personal: the same org holds somebody in a truck and somebody at a desk. */}
        <Section title="How Nort talks to you">
          <NortTone
            humor={clampHumor((profile as any)?.nort_humor)}
            register={asRegister((profile as any)?.nort_register)}
            notes={typeof (profile as any)?.nort_notes === "string" ? (profile as any).nort_notes : ""}
          />
        </Section>
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
  //
  // ELEVEN GROUPS, NOT SEVEN (cn-v695). Erik: "i want to have the settings broken down into as
  // many setting as possible for each thing on their own page with a sub nav more broken down…
  // i dont like having to scroll to look for settings neither does andrew."
  //
  // The old shape had thirty-odd panes crammed into seven clusters, and two of them were doing
  // most of the damage: Website held nine panes (domain, homepage, portfolio, reviews, articles,
  // custom pages, the lead link, the QR, collaborator seats) and Money & Docs held eight. Either
  // one is a scroll, which is the exact complaint. The cap was never editorial — it was the old
  // horizontal pill strip, which had to stay short to fit on a line. That nav became a vertical
  // column in cn-v6xx, so the ceiling is gone and the groups can multiply until each one is a
  // thing you can NAME. A group you can name is a group you can find without reading it.
  //
  // Two panes also moved because they were simply filed wrong:
  //   · "Getting paid" (Stripe Connect) lived under Company — it is how money reaches the bank,
  //     not who we are. It now leads its own group with the CN subscription, because "how do I
  //     take a card" and "what am I paying for this" are the two bills an owner hunts for.
  //   · "Pricing & catalog" was a pair of link cards under Company that pointed at the price
  //     list — the same door the Price list pane already opens, one cluster away. The duplicate
  //     is gone; the kits card it also carried moved next to the price list, where the book is.
  const adminTabs = org && isStaff
    ? [
        // "Company" — just who we are. Set once at signup and rarely touched again, which is
        // exactly why it is small: everything that used to pad it out had a better home.
        {
          id: "company",
          label: "Company",
          icon: Building2,
          content: (
            <div className="space-y-6">
              <Section title="Company details"><OrgSettingsForm org={org as Organization} /></Section>
              <Section title="Company logo">
                <LogoUpload orgId={(org as Organization).id} current={(org as Organization).logo_url} />
              </Section>
            </div>
          ),
        },
        // "Playbook" — the questions this company's own walk-through asks, and WHY each one is
        // worth asking. Second in the list on purpose: it is the one thing here that changes what
        // happens on a job site, and there has never been anywhere in this app to read it.
        {
          id: "playbook",
          label: "Playbook",
          icon: ClipboardList,
          content: (
            // Second home for the tour's playbook anchor. The desktop cluster link carries the
            // same name and comes first in the DOM, so a computer spotlights the nav item; on a
            // phone that column is hidden at zero size and the spotlight falls through to this,
            // the panel itself — which is what he's actually looking at there anyway.
            <div data-tour="settings-playbook" className="space-y-6">
              <Section title="What your walk-through asks">
                {/* THE WHY-LINES LESSON, offered where why lines live (cn-v726 split). Erik's
                    brief for the tour was that nobody works this out unaided; teaching it on day
                    one, seventeen steps from this screen, is how it drifted. Offered once —
                    lessons_seen (0197) — and replayable forever from the cap. */}
                <LessonOffer
                  lessonKey="why-lines"
                  seen={Array.isArray((me as { lessons_seen?: unknown } | null)?.lessons_seen) ? ((me as { lessons_seen: unknown[] }).lessons_seen as unknown[]).map(String) : []}
                  initial={{}}
                />
                <p className="mb-4 text-sm text-slate-500">
                  These are the questions your inspector asks on site, in order, and the reason each one exists.
                  A question only shows when it applies — and one that&rsquo;s already been answered, out loud or
                  from the lead, never gets asked at all.
                </p>
                <PlaybookManager
                  forms={playbookForms}
                  starters={PLAYBOOK_STARTERS.map((s) => ({ key: s.key, label: s.label, blurb: s.blurb }))}
                />
              </Section>
              <Section title="How Nort writes an estimate">
                <QuotePlaybookForm settings={settings} />
              </Section>
            </div>
          ),
        },
        // "Money" — what a number becomes: tax, markup, the book it comes from, and how a
        // customer hands it over. NOT the paperwork it prints on (that's its own group now) and
        // not the two bills (Stripe/subscription, also their own).
        {
          id: "money",
          label: "Money",
          icon: Wallet,
          content: (
            <div className="space-y-6">
              <Section title="Tax, pricing & financial defaults"><TaxRatesManager taxRates={(taxRates ?? []) as any} pricingLevels={(pricingLevels ?? []) as any} settings={settings} /></Section>
              {/* "How we quote" moved to the Playbook cluster — it is the same idea one step
                  later (what you ask on site → how the estimate gets written), and having two
                  things called a playbook in two different clusters was the confusion. */}
              {/* The price list is its own page and stays there — this is the door plus the one
                  thing that genuinely belongs in Settings: which markup governs it. */}
              <Section title="Price list">
                <PriceListCard
                  itemCount={priceItemCount ?? 0}
                  unpricedCount={priceUnpriced ?? 0}
                  noMarkupCount={priceNoMarkup ?? 0}
                  shiftedCount={priceShifted ?? 0}
                  defaultMarkupPct={settings.default_markup_pct}
                  levels={((pricingLevels ?? []) as { name: string; markup_pct: number }[]).map((l) => ({
                    name: l.name,
                    markup_pct: l.markup_pct,
                  }))}
                />
              </Section>
              {/* The other half of the book. Kits are edited on the price-list page like the
                  items are; what belongs here is the door, next to the door for the items —
                  they are one catalog and used to sit in two different clusters. */}
              <Section title="Kits & job lists">
                <Link
                  href="/price-list?tab=kits"
                  className="block rounded-xl border border-slate-200 p-4 transition hover:border-brand"
                >
                  <div className="flex items-center gap-2 font-medium text-slate-800">
                    <Layers className="h-4 w-4 text-slate-400" />
                    Open kits &amp; job lists
                  </div>
                  <p className="mt-1 text-sm text-slate-500">
                    Build the lists you pick from when you write an estimate — and set which lines size
                    themselves from the measurements taken on a walk-through.
                  </p>
                </Link>
              </Section>
              <Section title="Payment methods"><PaymentMethods settings={settings} /></Section>
            </div>
          ),
        },
        // "Estimates & invoices" — the paperwork itself: what it says by default, what it's
        // numbered, and what it looks like. Split out of the old Money & Docs because "change
        // my payment terms" and "change my tax rate" are different errands.
        {
          id: "docs",
          label: "Estimates & invoices",
          icon: FileText,
          content: (
            <div className="space-y-6">
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
            </div>
          ),
        },
        // "Getting paid" — the two money rails that AREN'T a job: the customer's card reaching
        // this contractor's bank, and this contractor's own bill from us. Both were buried one
        // cluster apart; both are things somebody goes looking for by name.
        {
          id: "getpaid",
          label: "Getting paid",
          icon: CreditCard,
          content: (
            <div className="space-y-6">
              <Section title="Card payments">
                {/* CONNECT (0161): the contractor's OWN Stripe account. Their customers'
                    money goes to their bank — Contractor North never holds it. */}
                {(() => {
                  const st = connectStateFromOrg(org as any);
                  const s = connectStatusLabel(st);
                  return (
                    <>
                      <div className="flex flex-wrap items-center gap-3">
                        <Badge tone={s.tone === "green" ? "green" : s.tone === "amber" ? "amber" : "slate"}>{s.label}</Badge>
                        <span className="text-sm text-slate-600">{s.detail}</span>
                      </div>
                      {billingEnabled ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {canAcceptPayments(st) ? (
                            <form action={openPayoutsDashboard}>
                              <Button variant="outline">View payouts</Button>
                            </form>
                          ) : (
                            <form action={connectPayments}>
                              <Button>{st.accountId ? "Finish setup" : "Set up card payments"}</Button>
                            </form>
                          )}
                        </div>
                      ) : (
                        <p className="mt-3 text-sm text-slate-400">
                          Card payments aren&apos;t switched on for the platform yet.
                        </p>
                      )}
                      <p className="mt-3 text-xs text-slate-400">
                        Payments go straight from your customer to your bank. We never hold your money and take no cut —
                        Stripe&apos;s processing fee is the only deduction.
                      </p>
                    </>
                  );
                })()}
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
        // "Crew & time" — Alexa's control plane. The old "Scheduling" cluster minus the customer
        // reminders, which were never about the crew.
        {
          id: "crew",
          label: "Crew & time",
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
            </div>
          ),
        },
        // "Customers" — every way a customer reaches us or hears from us, in one place. The two
        // inbound doors were filed under Website (because that's where the link gets pasted) and
        // the outbound reminders under Scheduling (because they fire off a date). Neither is
        // where anyone looks for "how do people get hold of me".
        {
          id: "customers",
          label: "Customers",
          icon: MessageSquare,
          content: (
            <div className="space-y-6">
              <Section title="Reminders & follow-ups"><AutomationSettings settings={settings} /></Section>
              {/* THE INTAKE DOOR (0185) — the "request an estimate" link for the org's own site.
                  The questions behind it are a form, under Playbook, once the door is on. */}
              <Section title="Request-an-estimate link">
                <IntakeCard
                  on={intakeOn}
                  url={settings.public_handle ? `${orgPublicBaseUrl(settings)}/intake/${settings.public_handle}` : null}
                  live={(() => {
                    // Reuse the row the playbook editor already loaded rather than probing again —
                    // the flagged form is right here, with its parsed needs.
                    const w = playbookForms.find((f) => f.isWebsite);
                    return w ? { id: w.id, name: w.name, count: w.needs.length } : undefined;
                  })()}
                />
              </Section>
              <Section title="Public lead link & QR">
                <p className="mb-2 text-sm text-slate-500">
                  Post this link online (or text/email it). Anyone who submits the form becomes a new lead in <strong>Leads</strong> — no login needed for them.
                </p>
                <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">
                  {inquiryUrl}
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
            </div>
          ),
        },
        // "Website" — the site's own settings: address/domain/style, the homepage, and who from
        // outside is allowed to edit it. What the site is MADE OF moved next door to "Photos &
        // pages" — nine panes in one column was the worst scroll on this page.
        {
          id: "website",
          label: "Website",
          icon: Globe,
          content: (
            <div className="space-y-6">
              <Section title="Your website">
                <WebsiteSettings settings={settings} siteUrl={siteUrl} sitesDomain={sitesDomain} />
              </Section>
              <Section title="Design studio">
                <p className="mb-2 text-sm text-slate-600">
                  Redesign the site by describing what you want — every pass is a version you preview before
                  anything goes live, and any older version can be brought back.
                </p>
                <Link
                  href="/site-studio"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Open the design studio
                </Link>
              </Section>
              <Section title="Homepage">
                <HomepageCard
                  settings={settings}
                  homeBlocks={renderReadyBlocks(settings.home_blocks)}
                  brand={accentHex(settings.glass_tint)}
                  orgId={(org as Organization).id}
                  siteUrl={settings.public_handle ? orgPublicBaseUrl(settings) : null}
                />
              </Section>
              <Section title="SEO / content collaborators">
                <CollaboratorsManager initial={(siteCollaborators ?? []) as any} />
              </Section>
            </div>
          ),
        },
        // "Photos & pages" — the content ON the site. Four managers that are each a real editing
        // session; nobody opens this one by accident, and nobody hunting for a domain name should
        // have to scroll past it.
        {
          id: "content",
          label: "Photos & pages",
          icon: Images,
          content: (
            <div className="space-y-6">
              <Section title="Portfolio photos">
                <PortfolioManager orgId={(org as Organization).id} initial={settings.portfolio ?? []} />
              </Section>
              <Section title="Reviews">
                <ReviewsManager initial={settings.reviews ?? []} />
              </Section>
              <Section title="Articles & blog">
                <PostsManager
                  initial={(sitePosts ?? []) as any}
                  siteUrl={settings.public_handle ? orgPublicBaseUrl(settings) : null}
                  handle={settings.public_handle}
                  orgId={(org as Organization).id}
                />
              </Section>
              <Section title="Custom pages">
                <PagesManager
                  initial={sitePages as any}
                  siteUrl={settings.public_handle ? orgPublicBaseUrl(settings) : null}
                  handle={settings.public_handle}
                  brand={accentHex(settings.glass_tint)}
                  orgId={(org as Organization).id}
                />
              </Section>
            </div>
          ),
        },
        // "Connections" — everything that talks to something outside this app. QuickBooks joins
        // the AI key and the calendar: it was under Money, but connecting an accounting login is
        // the same errand as connecting a calendar, not the same errand as setting a tax rate.
        {
          id: "integrations",
          label: "Connections",
          icon: Plug,
          content: (
            <div className="space-y-6">
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
              <Section title="Google Calendar">
                <GcalCard
                  configured={gcalConfigured()}
                  connected={!!gcalConn}
                  flash={gcal}
                  selectedCalendars={
                    Array.isArray((gcalSync as { selected_calendars?: unknown } | null)?.selected_calendars)
                      ? ((gcalSync as { selected_calendars: unknown[] }).selected_calendars.filter(
                          (c): c is string => typeof c === "string",
                        ))
                      : []
                  }
                  lastSyncedAt={(gcalSync as { last_synced_at?: string | null } | null)?.last_synced_at ?? null}
                  needsReauth={connectionNeedsReauth(gcalSync)}
                />
              </Section>
              <Section title="AI assistant">
                <AiStatus
                  configured={!!process.env.ANTHROPIC_API_KEY}
                  model={process.env.ANTHROPIC_MODEL || "claude-opus-4-8"}
                />
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
  //
  // OLD LINKS KEEP LANDING (cn-v695). Splitting the clusters retired one id, and the fallback
  // above is silent — a bookmarked ?tab=scheduling would have dropped somebody on Company with
  // no hint that their link meant something. One alias is cheaper than that confusion.
  const TAB_ALIASES: Record<string, string> = { scheduling: "crew" };
  const wanted = TAB_ALIASES[tab ?? ""] ?? tab;
  const active = clusters.find((c) => c.id === wanted) ?? clusters[0];
  // The nav needs only id/label per cluster — the icon is resolved client-side by id in
  // SettingsSubnav. (Passing c.icon, a lucide component/function, across the server→client
  // boundary threw "Functions cannot be passed to Client Components" and crashed /settings.)
  const navClusters = clusters.map((c) => ({ id: c.id, label: c.label }));

  return (
    // THE NAV SITS FLUSH, THE CONTENT KEEPS ITS READING WIDTH.
    //
    // Erik: "something happened to the sub-nav's position and its sticking out way too far."
    // It was never too wide — 208px, the same as always. It was ~400px too far RIGHT, because
    // `mx-auto max-w-5xl` wrapped the WHOLE thing: at a 1900px window that centres a 1024px block
    // inside 1816px of space, so the nav floats in the middle of the page with a wide empty gutter
    // between it and the dock rail. Every other page's nav is the dock's own 186px column, flush
    // against the rail (app-shell/dock.tsx:113) — Settings was the one page where the nav drifted.
    //
    // So the cap moves OFF the outer row and ONTO the content column, which is what it was always
    // for. The nav goes back where every other nav in the app lives, and a 900px window is
    // unaffected because the subnav is still lg-only (see dock.tsx:104 for why that matters).
    <div>
      <PageHeader title="Settings" description="Configure every part of your business." />
      {/* Two columns on desktop, stacked on a phone (the subnav renders its own slide-over
          there). `items-start` so the sticky sidebar can actually stick instead of being
          stretched to the content's full height by the default `stretch`. */}
      <div className="shell:flex shell:items-start shell:gap-6">
        <SettingsSubnav clusters={navClusters} activeTab={active.id} />
        <div className="min-w-0 max-w-4xl flex-1">{active.content}</div>
      </div>
    </div>
  );
}
