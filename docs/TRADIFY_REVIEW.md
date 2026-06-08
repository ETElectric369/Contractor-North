# Tradify Backend Review — feature map & gap analysis

Live walkthrough of Erik's Tradify account (tradifyhq.com) to map functionality and
find gaps/opportunities for Contractor North (CN). Updated as we tour each screen.

## Tradify main navigation (left sidebar)
Dashboard · To-Do List · Inquiries · Jobs · Map · Invoices · Quotes · Purchases ·
Scheduler · Timesheets · Website · Customers · Suppliers · Connections · Reports ·
Settings · Help

> CN has most of these. Notable CN gaps at nav level: **Suppliers** (dedicated
> vendor records), **Website** (lead-capture site builder), **Connections**
> (integration hub), and a richer **Reports** suite.

## Tradify Settings taxonomy (21 sections) — blueprint for CN Settings revamp
| # | Tradify setting | CN today | Gap / action |
|---|---|---|---|
| 1 | **Billing Rates** | profiles.hourly_rate (single) | Named billing rates w/ charge-out $/hr **and** internal cost for profit |
| 2 | **Bills & Purchases** | bills table + /bills | Settings for default supplier, approval, markup |
| 3 | **Company** | OrgSettingsForm | ✅ have; expand (logo, branches, hours) |
| 4 | **Document Themes** | DocumentDesigner | ✅ have (Classic/Modern/Minimal) |
| 5 | **Email** | — | Email templates + from-name/signature/BCC |
| 6 | **Inquiries** | leads | Inquiry sources, statuses, auto-assign |
| 7 | **Integrations** | QuickBooks only | Integration hub |
| 8 | **Invoices** | doc numbering | Defaults: terms, due days, footer, numbering prefix |
| 9 | **Jobs** | job statuses fixed | Custom statuses, categories, default labor rate |
| 10 | **Kits** | — | **Prebuilt material+labor bundles** (big gap) |
| 11 | **Payments** | Stripe (dormant) | Accepted methods, surcharge, deposit % |
| 12 | **Plan & Billing** | Subscription card | ✅ have |
| 13 | **Price List** | inventory items | **Catalog of priced items/services** for quotes |
| 14 | **Pricing Levels** | — | **Tiered customer pricing** (markup levels) |
| 15 | **Quotes** | doc numbering | Defaults: validity days, terms, numbering prefix |
| 16 | **Scheduler** | schedule page | Working hours, slot length, colors, defaults |
| 17 | **Security** | RLS roles | 2FA, password policy, session controls |
| 18 | **Staff Members** | InviteManager + team | ✅ have; add per-staff rates/permissions |
| 19 | **Tax** | default_tax_rate (single) | **Multiple named tax rates** |
| 20 | **Timesheets** | timeclock | Rounding, overtime rules, approval |
| 21 | **Refer A Friend** | — | (referral program — low priority) |

### Detail captured
**Billing Rates** (Settings → Billing Rates): a list of named hourly rates used on
quotes, invoices, and time tracking. Each has a charge-out $/hr; advanced option for
an internal hourly cost to compute profit. One is marked DEFAULT.
- Erik – Labor (DEFAULT) $100/hr · Jimmy/Joseph/Mark – Labor $60/hr · Technical Labor $150/hr
- **CN gap:** CN stores one `hourly_rate` per profile (used for job-cost labor only).
  No charge-out vs internal-cost split, no generic/named rates (e.g. "Technical Labor").

### Settings → Jobs (sub-tabs)
- **Job Numbers:** editable prefix (`JOB`) + Next Job Number (`1146`). CN auto-numbers via
  doc_counters but doesn't expose prefix/next-number in the UI → add editable numbering.
- **Custom Fields:** user-defined fields on jobs. CN gap → custom fields engine.
- **Job Statuses:** user-defined statuses. CN has a fixed enum → make statuses configurable.
- **Job Categories:** categorize jobs. CN gap.
- **Job Service Reports:** configurable on-site report templates. CN gap (this is the
  "Service Reports" item already on our backlog).

## Running opportunity list (CN can do better)
- Editable doc numbering (prefix + next #) for Jobs/Quotes/Invoices/POs in Settings.
- Custom fields + custom statuses + categories for Jobs (and likely Quotes/Customers).
- Billing Rates with charge-out vs internal cost.
- Kits, Price List, Pricing Levels.
- **Configurable job statuses** (name + color + drag order + add custom). Tradify ships:
  Unassigned, Assigned, Scheduled, In Progress, On Hold, **To Invoice**, Complete, Canceled.
  CN has a fixed enum — at minimum add **Unassigned/Assigned** (dispatch) and **To Invoice**
  (ready-to-bill handoff); ideally make statuses org-configurable with colors.
- **Quote settings:** editable prefix/next #, **default expiration days (30)**, allow
  online **accept + decline**, **automated email & SMS follow-up reminders** with a custom
  message (≤220 chars). CN has online accept only → add expiry, decline, and auto follow-ups.
- **Invoice settings:** editable prefix/next #, **default due terms** (net days),
  generate-from-appointments vs timesheets, use-timesheet-notes-as-line-items, and
  **automated payment reminders** (email + SMS, custom message) + "mark paid when
  customer notifies." CN gap → due terms, reminder engine.
- **THEME — Reminder/automation engine:** Tradify automates quote follow-ups + invoice
  payment reminders over email & SMS. CN has Twilio/Resend stubs but no scheduled
  reminder engine. High-value differentiator to build (we can make it smarter/AI-worded).
- **Tax settings:** **multiple named tax rates** by jurisdiction (No Tax 0%, Reno NV 1.07%,
  Truckee 9%), separate **Sales vs Purchase** tax defaults, and a **tax calculation method**
  (per-line vs total). CN has one `default_tax_rate` → build a tax_rates table + pickers on
  quotes/invoices. Real need for Erik (Reno vs Truckee jobs).
- **Kits (HIGH VALUE):** reusable bundles of materials + labor + misc costs, organized by
  Kit Categories, dropped onto quotes to speed common-service quoting. CN has AI take-offs
  but no saved priced kits. Build a `kits` + `kit_items` model + "Add kit" on the quote
  builder. Pairs great with our AI (AI can suggest/assemble kits).
- **Price List (HIGH VALUE):** unified catalog (Item Code, Description, Supplier, Category,
  Buy Price, Standard Markup) reusable across Jobs/Quotes/Invoices/Bills/POs, with **CSV
  import of supplier price lists** + categories. CN has Inventory + material lists but no
  unified priced catalog or supplier import. **Killer for Erik: import the CED price list
  via CSV** → real part #s & pricing into quotes/POs. Differentiator: AI maps messy supplier
  CSVs automatically.
- **Pricing Levels:** customer pricing tiers (markup % on Price List + per-level hourly
  rates), assigned per customer; "default level" for new customers. CN has flat pricing →
  add pricing tiers (ties to Price List + Billing Rates). Good for trade vs retail margins.
- **Scheduler settings:** configurable working day start/end (calendar bounds), appointment
  card title content, and **customer appointment confirmations (email) + reminders (SMS)**.
  CN scheduler has none → add working hours + appointment confirm/remind (reminder engine).
- **Timesheets settings:** configurable **week start** (Mon) + **time tracking method**
  (start/end vs duration). CN timecards are fixed → add week-start + method settings.
- **Email settings:** customizable **email templates per doc type** (Estimate, Quote,
  Invoice, PO, Job Service Report, Forms & Certs, Service Reminder) w/ logo/links. CN emails
  are hardcoded → template editor with merge fields.
- **Service Reminders (recurring revenue):** Tradify can send recurring maintenance/service
  reminders to customers (e.g. annual panel/safety check). CN has nothing → big recurring-
  revenue feature; pairs with reminder engine + AI-personalized messages.
- **Payments settings:** Stripe connect (have) + **configurable payment-methods list**
  (Cash, Check, PayPal, Venmo…) for recording manual/field payments. CN gap → method list +
  method picker when marking invoices paid.
- **Company settings:** add **Currency** + **System Time Zone** (CN lacks both; needed for
  reselling to other regions) + Tax Number/EIN.

## Cross-cutting themes (what makes Tradify feel complete)
1. **Everything is configurable** — doc numbering (prefix + next #), statuses, categories,
   custom fields, working hours, week start, tax rates, payment methods, pricing tiers.
2. **Customer-facing automation engine** — auto email + SMS for: quote follow-ups, invoice
   payment reminders, appointment confirmations/reminders, and recurring service reminders.
   THIS is the biggest functional gap and our best differentiator (make it AI-worded).
3. **Pricing infrastructure** — Billing Rates (charge vs internal cost), Price List (catalog
   + supplier CSV import), Kits (bundles), Pricing Levels (customer tiers). Quoting speed.
4. **Customizable comms** — email templates per doc type with merge fields/branding.

## Recommended CN build order (post-tour)
**A. Settings revamp (do now):** tabbed control panel — Company (+currency/timezone),
   Numbering (editable prefixes/next # per doc), Financial (tax rates list, default labor
   rate, deposit), Quotes/Invoices (terms, expiry/due days, online accept+decline),
   Scheduler (hours, card title), Timesheets (week start/method), Payments (methods list),
   Job statuses/categories, Branding, Integrations, Team, Profile.
**B. Reminder/automation engine** (email+SMS for quotes/invoices/appointments + recurring
   service reminders) — biggest differentiator.
**C. Pricing infra** — Price List w/ CED CSV import → Kits → Pricing Levels → Billing Rates.
**D. Custom fields + configurable statuses/categories; Job Service Reports.**
