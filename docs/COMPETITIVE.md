# Contractor North vs. Tradify — gap analysis & workflow review

_Reviewed Tradify's public feature docs (June 2026) and mapped them against what
Contractor North does today. Goal: a turnkey flow from **Lead → … → QuickBooks**._

## Scorecard

| Capability | Tradify | Contractor North | Notes |
|---|---|---|---|
| Inbound lead capture (web form / email → lead) | ✅ | ❌ | We have a Leads list + follow-up, but no *inbound* capture |
| Lead follow-up tracking | ✅ | ✅ | We have last-contacted / next-follow-up |
| Customer CRM | ✅ | ✅ | |
| Quotes / estimates | ✅ | ✅ **+AI** | We add AI line-item generation; we lack supplier price-list import |
| Quote → customer (email / text / link) | ✅ | ✅ | We have email, **SMS**, and a public link |
| Quote accept (customer signs off) | ✅ | ❌ | Our public quote is view-only — **no Accept button** |
| Scheduling (agenda) | ✅ | ✅ basic | |
| Dispatch map / live staff GPS locations | ✅ | ❌ | We capture GPS at clock-in but don't show a dispatch map |
| Google/Outlook calendar sync | ✅ | ❌ | |
| Job management hub | ✅ | ✅ | We just added /jobs/[id] with docs |
| Photos / receipts / docs on jobs | ✅ | ✅ | Just built (private, per-job) |
| Multiple sites per customer | ✅ | 🟡 | We use a single address per job |
| Work orders | ✅ | ✅ | |
| Timesheets | ✅ | ✅ **stronger** | GPS, job codes, **multi-job split**, manual + edit, office review, voice, Spanish |
| Materials / price lists | ✅ | 🟡 | We have material lists; no supplier price-list import |
| Purchase orders | ✅ | ✅ | We have POs + receiving + PO-from-material-list |
| PO approval workflow | ✅ | ❌ | |
| Supplier bills / cost tracking | ✅ | ❌ | Needed for job costing + QuickBooks bills |
| Invoicing | ✅ | ✅ | From quote, statuses, email/text/link, branded templates |
| **Online customer payments (card)** | ✅ Stripe | ❌ | Our Stripe is for *our* subscriptions, not customer invoice payments |
| Automated overdue-invoice reminders | ✅ | 🟡 | We have the SMS/email infra, not this sequence |
| Recurring / progress invoicing | ✅ | ❌ | |
| **QuickBooks / Xero sync** | ✅ | ❌ | **Biggest gap** — no accounting integration at all |
| Job costing / profit per job | ✅ | 🟡 | We have A/R + hours; no labor-cost + materials vs quote report |
| Reporting / analytics | ✅ | 🟡 | Dashboard widgets only |
| Native mobile apps | ✅ | 🟡 | We're responsive web (works on phone), no native app |
| Change orders / variations | ✅ | ✅ | |
| Branded document themes | ✅ | ✅ | Logo + per-doc templates + brand color |
| Subcontractor access | ✅ | 🟡 | We have roles/invites; no free sub tier |
| Multi-tenant SaaS (sell to others) | ❌ (they host) | ✅ | We're built to be resold |

**Where we already match or beat Tradify:** AI quoting, the timeclock (GPS +
multi-job + voice + Spanish + office review), branded documents, SMS/email/public
links, and being multi-tenant so *you* can sell it.

---

## The turnkey workflow: where the chain breaks

Lead → Quote → **Accept** → Job → Schedule → Work (time + materials) → Invoice →
**Payment** → **QuickBooks**.

Today these modules exist but the **hand-offs are manual**, which is what makes it
feel less "turnkey" than Tradify:

1. **Lead → Quote:** fine (New quote from a customer).
2. **Quote → Accept:** ❌ broken — the customer can view the quote online but
   can't accept it. No trigger.
3. **Accept → Job:** ❌ accepting a quote doesn't create the job/schedule it.
4. **Job → Invoice:** 🟡 manual ("create invoice from quote"); doesn't pull in
   logged materials/labor or change orders automatically.
5. **Invoice → Payment:** 🟡 manual record only — customer can't pay online.
6. **Payment → QuickBooks:** ❌ nothing syncs to accounting.

Closing those six hand-offs is what turns a pile of good modules into a pipeline.

---

## Top gaps to close (prioritized)

### 1. QuickBooks Online integration 🔴 (the headline ask)
Sync **customers, invoices, payments, and supplier bills** to QuickBooks Online so
the books are done without re-keying. This is a real build: Intuit OAuth2, an
`accounting_connections` table, entity mapping (customer↔QBO customer, invoice↔QBO
invoice, item mapping), and push-on-status-change. **Needs your QuickBooks Online
account + an Intuit developer app** (client id/secret) to activate — I'd scaffold
it config-ready like Stripe/Twilio.

### 2. Online customer payments (close the cash loop) 🔴
A **"Pay now"** button on the public invoice link → Stripe Checkout → records the
payment automatically and (later) syncs to QuickBooks. Distinct from our
subscription Stripe; uses the contractor's own Stripe (Stripe Connect or their key).

### 3. Turnkey hand-offs (intuitiveness) 🟠
- **Accept** button on the public quote → status `accepted` → **auto-create the job**.
- **"Invoice this job"** that pulls the quote total + approved change orders (and
  optionally logged materials/labor) into a draft invoice.
- Status automation: quote accepted → job; job complete → draft invoice.

### 4. Job costing / profitability 🟠
Per job: **labor cost** (hours × each person's rate — we already store `hourly_rate`),
**material cost** (POs/receipts), vs **quoted/invoiced** → margin. A single "Job
profit" card. High value, uses data we already capture.

### 5. Supplier bills 🟠
Record supplier invoices (cost side) against a job → feeds job costing **and** the
QuickBooks "bills" sync.

### 6. Inbound lead capture 🟡
A public "request a quote" form (on ContractorNorth.com or a hosted page) → creates
a Lead. Starts the funnel automatically.

### 7. Automated reminders 🟡
We have Twilio/email wired — add the **sequences**: quote follow-up if not accepted
in N days, invoice reminder if overdue. (Re-uses the cron pattern.)

### 8. Scheduling depth 🟡
Dispatch **map** with live tech locations (we already capture GPS), calendar sync,
drag-to-reschedule.

---

## Intuitiveness improvements (quick wins)
- **Global search** (jump to any customer/job/quote/invoice).
- **"Convert" actions everywhere** (lead→quote, quote→job, job→invoice) so data
  carries forward instead of re-entry.
- **Status pipelines** shown as a visual flow on the job page.
- **Copy-link** buttons (share a quote/invoice with zero setup).
- **Per-job activity timeline** (quote sent, accepted, scheduled, invoiced, paid).

---

## Recommended build order
1. **Turnkey hand-offs** (#3) — small, makes the existing modules feel like one flow.
2. **Online payments** (#2) — closes the cash loop; high customer value.
3. **Job costing** (#4) — uses existing data; sells the product.
4. **QuickBooks** (#1) — the headline, but the biggest build; needs your QBO + Intuit app.
5. Supplier bills (#5) → unlocks deeper costing + QB bills.
6. Lead capture (#6), reminders (#7), scheduling depth (#8).

## Sources
- [Tradify features](https://www.tradifyhq.com/features)
- [Tradify purchase orders](https://www.tradifyhq.com/features/purchase-order-software)
- [Tradify + QuickBooks](https://www.tradifyhq.com/blog/connect-quickbooks-with-job-management-software)
- [Tradify QuickBooks Online setup](https://help.tradifyhq.com/hc/en-us/articles/360020338774-How-To-Integrate-Tradify-With-QuickBooks-Online)
