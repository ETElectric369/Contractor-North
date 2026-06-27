# Native App Plan — Contractor North on iPhone (and Android)

**Goal:** get the Tradify-style "tap → pick a contact from your phone → it fills the form" working
on Erik's (and the crew's) iPhones — plus working iOS push, native camera, and a real home-screen
app. The web app *cannot* do this (Apple gives web pages no access to Contacts); a **native shell**
can. This plan is how we get there with the **least rewrite, lowest risk, and fastest path to your
phone.**

Researched June 26 2026 (4-agent sweep of Capacitor + Next.js, App Store rules, our codebase, and
solo-dev timelines). Sources cross-checked against current Capacitor/Apple docs.

---

## The big realization: TestFlight, not the App Store

To USE the native app yourself, you do **not** need to pass App Store review. Apple's **TestFlight**
lets you add yourself + up to 100 of your own team as "internal testers" and install the app **with
no review** — same day after setup. So:

- **For you + Alexa + crew:** Capacitor shell → TestFlight → contacts work. **No App Store, no 4.2
  rejection risk.** (Builds refresh every 90 days; one re-upload each time.)
- **For selling it to other contractors (public download):** that's the App Store, a bigger gauntlet
  we tackle *later* when the multi-tenant SaaS goes to market.

This splits a scary 3-5 month "ship to the App Store" project into a **few-week "get it on your
phone"** project. That's the path.

---

## Architecture decision (the one that matters)

**Use Capacitor with `server.url` pointing at the live hosted app.** The native shell is a thin
iOS/Android wrapper whose WebView loads `contractor-north` (the deployed Vercel app), and native
plugins (Contacts, Push, Camera) bridge into it. **Keeps 100% of the current app — zero rewrite.**

Why not the "textbook" Capacitor approach (static export bundled in the app)? Because our app is
built on **React Server Components + Server Actions** — the entire `executeAction` registry, every
server action, all the SSR pages. Static export (`output: 'export'`) **deletes all of that** — it'd
be a multi-month rewrite of the whole backend into client-fetch + APIs. Not worth it; `server.url`
keeps everything working as-is.

The tradeoffs we accept with `server.url`, and how we handle them:
| Tradeoff | Reality | Our mitigation |
|---|---|---|
| Needs network (no full offline) | The app already needs the DB to be useful | A small native "you're offline" screen; cache static assets |
| App Store 4.2 "not just a website" | Real risk *for public App Store* | We add genuine native features (contacts/push/camera) AND we start on **TestFlight, which has no 4.2 review** |
| Plugin/native version upkeep | ~5-10 hrs/month | Accept it; it's the cost of a native app |

---

## The three real risks (validate the first one FIRST)

1. **🔴 Auth in the WebView (the go/no-go).** Our login is a Supabase **cookie** session (refreshed
   in middleware). iOS WKWebViews have a history of dropping cookies when the app backgrounds —
   which would log you out constantly. **This is the one unknown that decides feasibility, so we
   test it before anything else.** If cookies don't persist, the fix is a localStorage-based session
   for the native build (scoped, doable) — but we need to know early.
2. **🟡 Push must be rebuilt for native.** Today's web-push (VAPID) does **not** work in a native
   app. Native iOS push = APNs via Firebase (FCM). That means a new `device_token` column on
   `push_subscriptions` + a native send-branch in `sendPushToProfiles()`. ~3-4 days of code + a
   Firebase project. **Deferrable to Phase 2** — contacts don't need it.
3. **🟡 iOS codesigning + review cycles eat calendar, not code.** The contacts *code* is ~1 day (the
   slot is already in `new-customer-button.tsx`). The weeks come from Apple's certificate/
   provisioning ceremony (where ~40% of solo devs get stuck first try) and, if we go public, App
   Store rejection cycles. We automate signing from day one to dodge most of that.

---

## Phased plan — "what I build" vs "what's yours" (Mac + Apple account)

### Phase 0 — De-risk spike (the gate). ~2-4 days, mostly setup.
- **Me:** add Capacitor to the repo, a `capacitor.config` with `server.url` → the hosted app, the
  iOS project scaffold, signing automated via GitHub Actions, and set the WebAuthn/`SITE_URL` env
  pinning the native origin needs.
- **You:** create the **Apple Developer account ($99/yr)**; on your Mac, open the project in Xcode
  and push a build to **TestFlight**; install it on your iPhone. (I'll give you exact click-by-click.)
- **The test:** log in on the native app, background it, reopen → are you still logged in? **That
  answer is the go/no-go.** If yes, we proceed. If no, we add the localStorage-session fix and retest.

### Phase 1 — Contacts (the actual goal). ~1-2 days of code after Phase 0.
- **Me:** add `@capacitor-community/contacts`, the `Info.plist` permission, and a third branch in the
  New Customer import (`Capacitor.isNativePlatform()` → `Contacts.pickContact()` → prefill). The web
  vCard fallback stays for browser users. → "Import 1 contact" becomes the real native picker,
  exactly like Tradify.
- **You:** rebuild in Xcode → TestFlight → test on your phone. Add Alexa + crew as internal testers.
- **Outcome:** you and the crew have the native app with phone-contacts import. **Goal met, no App
  Store needed.**

### Phase 2 — Native push + camera + polish. ~1-2 weeks of code.
- **Me:** APNs/FCM push (the `device_token` migration + send-branch — your *built-but-dark* push
  finally works on iPhone), native camera for receipts/photos, hide the web push UI on native, and a
  URL-interception layer so document/screenshot/print links open natively. These also make a strong
  App Store 4.2 case later.

### Phase 3 — Public App Store + Android (only if/when you want public download). 4-8 weeks calendar.
- Screenshots, privacy policy, submit to App Store (budget 1-2 rejection cycles); Android adds
  Google Play ($25 one-time) + Apple's/Google's review gates (Android has a mandatory 14-day
  closed-testing window for new accounts).

---

## Costs & realistic timeline

- **Hard costs:** Apple Developer **$99/yr** (needed for Phase 0). Google Play **$25 once** (only at
  Phase 3). That's it.
- **To contacts-on-your-phone (Phases 0-1):** ~**2-4 weeks calendar** — and most of that is the
  one-time Apple account + codesigning + TestFlight setup, not coding. The contacts code is a day or two.
- **To a polished internal app (through Phase 2):** ~**4-6 weeks**.
- **To public App Store + Android (Phase 3):** another **1-2 months**, dominated by review cycles.

## Recommendation

**Do Phase 0 now** — it's cheap ($99 + a few days), and it answers the single question that decides
everything (does our cookie auth survive in the WebView). If it passes, **Phase 1 gets you the
Tradify-parity contacts import on TestFlight within a couple of weeks**, no App Store required. Push,
camera, and public distribution come after, only as far as you want to take it.

The only thing I can't do for you is the Apple account + the Xcode/TestFlight clicks on your Mac —
I'll write those out step by step so it's not guesswork.
