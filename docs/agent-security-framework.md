# Contractor North — AI Agent Security Framework (v1)

**Status: the gate.** No capability that lets the AI agent *act* (voice or chat) ships until it passes
this framework. This document is the contract we lock before building the agent layer. Grounded in web
research 2026-06-18 (sources at the end); legal points are flags for counsel, not legal advice.

---

## 0. The one-line contract

> **Face ID / passkey is the only identity & security gate. Voice is a non-security intent filter. The
> Action Registry is the single chokepoint. Sensitive actions require fresh re-auth + a confirmation that
> names the customer/$/impact. Every action is audited and reversible. Tenants are hard-isolated.**

If a proposed feature can't satisfy that sentence, it doesn't ship.

---

## 1. Decisions locked (with the reality that forced them)

1. **Voice is FOREGROUND PUSH-TO-TALK only.** An iOS home-screen PWA **cannot** do always-on or
   screen-off wake-word listening — iOS freezes the app's JavaScript and mutes the microphone the instant
   it loses foreground or the screen locks. So "hey Claude" from a pocket is **impossible on the web app**;
   the realistic hands-free envelope is *phone mounted in a cradle, screen kept awake, app in foreground,
   tap-to-talk*. (True always-on wake word would require a **native iOS app** — explicitly out of scope.)
2. **Capture audio ourselves; don't use Apple's Web Speech API.** `SpeechRecognition` is unreliable/absent
   in installed PWAs **and** ships the audio to Apple's servers — unacceptable for customer financial/PII
   data. Voice path = `getUserMedia` capture → **our** backend speech-to-text (under our DPA).
3. **Identity = Face ID / passkey (WebAuthn).** The biometric stays in the device Secure Enclave and never
   reaches our backend — we only ever receive a cryptographic assertion. We never build server-side
   biometric matching.
4. **The voice "intent filter" is non-security, on-device only, and never identity.** It only answers
   "did the already-authenticated owner mean to speak?" It is never the gate to data, never compared across
   people, never stored on our servers, and never marketed as a "voiceprint." (This is also the legal safe
   harbor — see §7.)
5. **The Action Registry (`src/lib/actions/`) is the single write chokepoint.** The agent can ONLY call
   named, validated registry actions — never arbitrary code, SQL, or endpoints.

---

## 2. The container — 7 pillars

| # | Pillar | What it means | Status |
|---|--------|---------------|--------|
| 1 | **Tenancy lock** | Every action runs as one authed user in one org; context built server-side (never client/voice-asserted); **RLS is the real data boundary**. | ✅ have (executeAction + buildActionCtx + RLS) — never weaken |
| 2 | **Least privilege** | Agent is only *offered* the actions the caller's role allows; tools filtered by role. | ◑ registry has `auth`; tool-filtering TODO |
| 3 | **Data ≠ instructions** | Anything the agent *reads* (notes, emails, transcripts, photos) is data, never commands. Named-action registry (no free-form execution) enforces this. | ◑ principle; make explicit in the agent |
| 4 | **Confirm + step-up** | Sensitive actions require a confirmation that names the impact + a **fresh** Face ID at action time. | ☐ build |
| 5 | **Voice = filter, not gate** | Per §1.4. | ✅ design locked |
| 6 | **Audit & undo** | Every agent action logged (who/what/when/result), attributable; reversible or human-only. | ☐ build (extend activity feed) |
| 7 | **Data minimization to the model** | Redact/tokenize PII + financial fields before they reach the LLM; DPA with no-training/zero-retention. | ☐ build + contract (§7) |

---

## 3. Action risk tiers

Every registry action gets a tier (extends the existing `confirm` field into a `risk` level):

- **Tier 0 — read.** Safe; no confirm. (list/overview tools.)
- **Tier 1 — reversible single-record write.** Run optimistically, **one-tap undo**, audited. (add a task,
  mark a bill paid, edit a note.)
- **Tier 2 — money / PII export / billing-affecting / cross-customer.** Explicit confirmation that **names
  the specific customer + dollar/PII impact**, gated behind **fresh passkey re-auth**. (record a payment,
  send an invoice, refund/credit, finish-job-and-invoice.)
- **Tier 3 — delete/export another subscriber's data, bulk changes, moving money out.** **Human performs the
  final step**; no autonomous agent execution.

> Industry consensus (Google/Amazon/Apple/OpenAI/Anthropic): reserve confirmations for genuinely
> consequential actions (avoid "confirmation fatigue"), make **undo + audit** the backstop for everything
> else, and for the riskiest actions hand control back to the human ("takeover mode").

---

## 4. The per-action checklist (the gate every new registry action passes)

- [ ] **Tenancy:** flows through `executeAction` → RLS-scoped, org-isolated. No raw cross-org reads/writes.
- [ ] **Role:** correct `auth` (any/staff/owner); agent tool exposure filtered to the caller's role.
- [ ] **Risk tier** declared; Tier 2+ wired to confirm + fresh step-up re-auth.
- [ ] **Input validated** (Zod); no free-form SQL or client-supplied identifiers/role.
- [ ] **Audited:** who/what/when/result, attributable to a person.
- [ ] **Reversible** (undo) — or it's Tier 3 (human-only).
- [ ] **Model data minimized:** no secrets, full card numbers, or raw PII beyond what the action needs.

---

## 5. Voice path (concrete)

- **Trigger:** a deliberate tap (a big "talk" button) — satisfies iOS's user-gesture requirement *and* the
  intent decision in one move.
- **Capture:** ONE long-lived `getUserMedia` stream for the session; stop on `visibilitychange` (the OS
  mutes it anyway). Keep the voice UI on real App Router paths (not hash routes) to avoid the iOS
  permission re-prompt bug.
- **STT:** our backend (Whisper/Claude), never Apple's Web Speech. Audio governed by the LLM DPA (§7).
- **Optional on-device speaker filter** (Picovoice Eagle ~4.5 MB WASM, fully on-device — or open-source
  ECAPA-TDNN via ONNX Runtime Web): intent-only. A low/borderline match → **fall back to a Face ID
  confirm**, never a hard block on a legit owner. Note: multi-tenant licensing for Eagle is a paid plan;
  this is a *later* enhancement, not v1.
- **Speak-back:** `speechSynthesis`, pre-warmed on the same tap, short confirmations only, with a text
  fallback (iOS may have no premium voices; first `speak()` needs a gesture).
- **Show-your-work (Erik's transparency rule):** every voice action **opens the real page/form and fills it
  live** as the user dictates; for Tier 2+, the confirm + Face ID happen **visibly**. Never a black box.

---

## 6. Identity path (concrete)

- **Login:** passkey / Face ID (WebAuthn). For a live multi-tenant app, prefer a **custom
  `@simplewebauthn`** flow (full control, production reliability) *or* Supabase's **native passkey beta**
  with the SDK pinned (it's experimental as of 2026-05). Stable **bare-domain RP ID** + iOS Associated
  Domains; `authenticatorAttachment='platform'`, `userVerification='required'`, always pass
  `allowCredentials`.
- **Step-up for Tier 2+:** a **custom WebAuthn ceremony bound to the specific action** (action id + key
  params), short-TTL server challenge, UV required, verified server-side, minting a **single-use** step-up
  token consumed by that one action. *The owner physically taps Face ID — the AI proposes, the human
  authorizes; the AI can never silently invoke Face ID.* (Supabase passkeys don't set AAL2, and the OTP
  `reauthenticate()` flow is not a biometric step-up — so this is custom by necessity.)
- **RLS stays the real boundary** regardless of auth method. Keep TOTP/Phone MFA + the AAL2 RLS gate as a
  coarse backstop for the riskiest tables.

---

## 7. The LLM-over-customer-data compliance track (do BEFORE the agent touches customer records)

This is the larger, more *certain* obligation — bigger than the voice question.

- **The LLM is a sub-processor.** Our subscribers are data controllers of *their* customers' data; we are
  their processor; the model is our sub-processor. Required: a **DPA with no-training / zero-retention**,
  classify the model vendor as a **CCPA "service provider,"** disclose it in our privacy policy **and** the
  subscriber DPA. Verify our subscriber Terms permit AI sub-processing.
- **Minimize:** redact/tokenize direct identifiers + financial fields before they reach the model.
- **Hard per-tenant isolation** of *all* prompts / context / RAG / history. A cross-tenant leak is both a
  CCPA "reasonable security" failure (breach private right of action) and a contract breach with subscribers.
- **Voice biometric legal posture:** a stored voiceprint *is* regulated (Illinois **BIPA** — the one with
  per-person private damages — plus TX CUBI, WA, CA CPRA). Our local-intent-filter design most likely stays
  **outside** BIPA's worst exposure *because it never identifies a speaker, never leaves the device, and
  never authenticates* — but that safe harbor holds **only** if it never drifts into identity. Document the
  data-flow in writing as the defense. **Washington's My Health My Data Act** has a private right of action
  and a broad voiceprint definition — get a WA/IL/TX scope check from counsel before launching voice there.

---

## 8. Build order (so the agent is never exposed prematurely)

1. **Registry plumbing + UI (no agent exposure).** Better buttons for the human only. ← *in progress, safe.*
2. **Audit log + risk tiers** on every registry action.
3. **Passkey login + custom step-up re-auth.**
4. **Data-minimization + the LLM DPA** (the gate before any agent-over-PII).
5. **Then, and only then, expose the agent — in order of risk:** read tools → Tier-1 writes (with undo) →
   Tier-2 writes (confirm + step-up). **Never Tier-3 autonomously.**
6. **Voice (push-to-talk + our STT + show-your-work + speak-back)** rides the *same* gated registry — voice
   adds no new power, only a new way to invoke what's already gated.

---

## Appendix — grounded constraints & sources (2026-06-18)

- **iOS PWA voice:** no background/screen-off mic or wake word (iOS suspends PWA JS + mutes mic on
  background/lock; no Background Sync/Fetch). `SpeechRecognition` throws "service not available" in
  standalone PWAs (WebKit bug 225298) and is server-based; `getUserMedia`+`MediaRecorder` work foreground
  since iOS 13.4 (WebKit 185448). Capture path is Safari/home-screen only, not iOS Chrome/WKWebView (WebKit
  208667). Sources: caniuse.com/speech-recognition; MDN SpeechRecognition; firt.dev/notes/pwa-ios; WebKit
  bugs 225298/185448/198277/208667.
- **On-device speaker filter feasible:** Picovoice Eagle Web (~4.5 MB WASM, offline, iOS PWA) — but paid
  multi-tenant licensing + AccessKey online activation; open-source fallback ECAPA-TDNN (~25 MB) via ONNX
  Runtime Web. Defeatable by recordings → intent filter only. Source: picovoice.ai docs.
- **Passkeys:** Supabase native passkeys experimental beta (announced 2026-05-28, needs supabase-js
  ≥2.105, "API may change"); custom SimpleWebAuthn is the production-safe path; passkeys don't set Supabase
  AAL2 so step-up is custom; every ceremony needs a user gesture. Sources: Supabase auth docs; W3C WebAuthn;
  Apple WebAuthn/Associated Domains docs.
- **Legal:** voiceprint = biometric identifier under BIPA/CUBI/WA/CPRA; local-only non-identifying filter
  likely outside BIPA; LLM-over-PII needs DPA + disclosure + minimization + hard tenant isolation; WA MHMDA
  has a private right of action. Sources: 740 ILCS 14 (BIPA), Cal. Civ. Code 1798.140 (CPRA), WA HB 1493 /
  My Health My Data Act, TX Bus. & Com. 503.001 (CUBI). **Confirm with counsel before IL/WA/TX voice.**
- **Prior art:** Google Face Match, Amazon Voice ID, Apple personalized Hey Siri all = personalization /
  false-trigger reduction, explicitly **not** authentication; tiered action-safety (optimistic+undo for
  low-risk; confirm-that-names-the-impact + re-auth for high-risk; human takeover for most sensitive).
