# LLM data handling (agent-security framework §7)

How customer data is handled when the in-app assistant talks to the model provider
(Anthropic), what's minimized in code, and the governance Erik must confirm out-of-band.
This is the "data minimization + DPA" pillar of the [[agent-security-framework]].

## What actually leaves for the provider

The assistant (chat) is **read-only** and runs every query through the signed-in user's
**RLS-scoped** Supabase client — so the model only ever sees **one org's** data, never
another tenant's. What's sent:

| Tool | Sent to the model | Minimization |
|---|---|---|
| `list_customers` | name + locality | **phone/email only on a specific search (≥3 chars) resolving to ≤5 matches** — a broad/short term gets name+locality only (cn-v174) |
| `list_invoices` / `list_quotes` | doc #, status, totals, **customer name only** | no contact PII; amounts are the org's own and needed to answer money questions |
| `list_jobs` / `schedule_overview` | job #, name, dates, status, customer name, jobsite location | location is needed for "where's my next job"; no contact PII |
| `business_summary` | aggregate counts + an outstanding-A/R number | no row-level PII |

The chat agent has **no write tools** (the input-as-data boundary holds by construction —
a prompt injection in returned customer text has no action it can trigger). Voice/agent
writes go through `executeAction` (role-gated, confirm-gated, money = WebAuthn step-up).

**Egress audit:** every chat turn that pulled org data logs a `chat.query` row to
`agent_audit_log` (org/user + the tool names that ran — never the content), so there's a
trail of which data categories left for the provider (cn-v178).

Image-based AI calls (receipt / handwritten-note parsing in Organize My) send the photo
itself to the model — those are user-initiated and org-scoped, but they are the least
minimizable path; treat them under the same provider terms below.

## Governance — confirm these out-of-band (not code)

These are **Erik's to verify with Anthropic** — the "DPA" is a contract/account matter,
not a code change. (No "zero-retention header" exists; do not add one — it's a no-op.)

1. **Commercial API, not consumer.** The paid Anthropic API does **not** train on your
   prompts/outputs by default — that's the commercial-terms default. Confirm the account
   key in use (`ANTHROPIC_API_KEY`) is a commercial/organization key, not a consumer plan.
2. **Sign Anthropic's DPA.** Because the app processes subscribers' customer PII + employee
   data across tenants, execute Anthropic's Data Processing Addendum (covers GDPR/CCPA
   sub-processor obligations). This is the formal "LLM DPA" the framework calls for.
3. **Consider Zero Data Retention (ZDR).** By default inputs/outputs may be retained for a
   short window for abuse monitoring; ZDR removes that and is available by arrangement.
   Worth it once real customer financials flow through the assistant at scale.
4. **Disclose the sub-processor.** Update the privacy policy / subscriber terms to name
   Anthropic as a sub-processor and describe what's sent. Each onboarded company
   (Tahoe Deck, future orgs) should be told an LLM assists in-app.
5. **Voiceprints (if ever built):** biometric data is BIPA/CCPA-regulated — keep any speaker
   filter on-device, consented, deletable; counsel check before IL/WA/TX. (Not built; the
   shipped voice is push-to-talk on the logged-in session — zero biometric data.)

> Verify items 1–4 against Anthropic's **current** terms — this doc reflects the posture
> as understood at authoring; provider terms change.

## Residual / future
- Apply the search-gated pattern to any new read tool that returns row-level PII.
- If/when the chat agent gains write tools, the input-as-data boundary becomes load-bearing
  — gate it (the registry confirm/step-up already exists for that).
