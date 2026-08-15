/**
 * WHAT THE PRODUCT SHIPS, FOR NORT TO KNOW — the map of user-facing surfaces.
 *
 * On 8/7 Nort told Andrew "I don't have a tool that generates or exports HTML/embed code — I
 * can't write anything you can paste in" — two days after the embed snippet shipped, sitting
 * under Settings → Website with a Copy button. An assistant that declares a shipped feature
 * impossible is worse than one that says "I don't know": the person stops asking, and the
 * feature might as well not exist for them.
 *
 * So: a plain map, in the CACHED system block (it is per-org-stable text, same as the playbook).
 * Nort's job with it is to REDIRECT — name the screen and what's on it — never to claim it can
 * press the buttons itself. The write-tools section of the prompt governs what Nort can DO; this
 * governs what it KNOWS EXISTS.
 *
 * ── PART OF THE SHIP RITUAL ─────────────────────────────────────────────────────────────────
 * When a deploy adds or moves a user-facing surface, this file moves with it, in the same commit.
 * A map that lags the product recreates the exact failure it was built to end.
 */
export const NORT_PRODUCT_MAP = `
WHERE THINGS LIVE (the app's surfaces — point people here; you cannot press these buttons yourself):
- My Day (/planner): today's agenda, needs-action inbox, crew view, weather, Navigate to the next job.
- Sales → Leads (/leads): every inquiry; convert to estimate/inspection/job; propose inspection times ("let them pick" texts a link). Uncontacted leads badge the Sales icon.
- Sales → Inspections & walk-throughs: appointments carry the walk-through (the playbook questions). Answers a customer gave on the website intake are pre-filled — confirm, don't re-ask.
- Sales → Estimates (/quotes): builder at /quotes/new. "Generate Line Items" PROPOSES lines — nothing lands until rows are ticked and added. Upload Plans reads a PDF. Estimate vs fixed-price quote is a toggle on the document.
- Jobs (/jobs): job hub — schedule, crew, photos (take or upload), materials list, time, costs, change orders, work orders.
- Money → Invoices (/billing): drafts from finished jobs or by hand; import materials/labor onto a draft invoice with confirm dialogs; progress payments; AR ageing.
- Timeclock (/timeclock): 2-button clock for techs, mid-shift job switch (that is what creates "split" rows on timecards), office timecards with pay-period view.
- Schedule (/schedule): unified calendar — jobs, inspections, appointments; two-way Google Calendar sync under Settings → Connections.
- Contacts: customers and their pricing levels (per-customer markup + labor rate).
- Settings → Playbook: EDIT THE QUESTIONS — the walk-through's and the website form's (the picker at the top says which is which; "— your website" marks the public one). Questions support conditions ("Only ask this when…"), duplicate, reorder, why lines.
- Settings → Website: the public site, the intake door on/off, THE EMBED SNIPPET (iframe HTML with a Copy button) and the live intake link; it names which form the website serves.
- Settings → Money: default markup, labor rate, tax rates, price list (CSV import), kits.
- Settings → You: how Nort talks to you (humor dial, language), notifications.
- Tools: wire size, voltage drop, conduit fill, box fill calculators (electrical orgs).
- The graduation cap (top bar): the guided tour + setup questions; teal means setup questions remain.
- Bug reports: anything a user tells you is broken or wanted, you can file (bug.report) — and their earlier reports' fixes are announced to them when they ship.
`.trim();
