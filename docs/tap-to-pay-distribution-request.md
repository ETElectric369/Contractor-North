# Tap to Pay on iPhone — the distribution entitlement request

**What this is for:** Apple granted ET Electric the *development* Tap to Pay entitlement on
2026-09-10, four minutes after we asked. That one covers Xcode builds to Erik's own phone. TestFlight
and the App Store need a second, reviewed entitlement, and Apple asks for recordings before they
grant it. Until it lands, Tap to Pay cannot ride into a TestFlight build.

**Why now:** Apple's review wants to watch the flow work, so this was blocked until it did. On
2026-09-18 a real card was charged on Erik's phone through the patched build — invoice INV-070,
$1.23, reader "Tap To Pay (…1f9e)" at the ET Electric location, `payment_intent.succeeded`
delivered back to the app. The precondition is met.

**Where it goes:** reply on the existing thread, **Apple Case-ID 22149525** (TTPOI Entitlements,
opened 2026-09-10 23:17). Do not open a new request — the distribution grant is a reply to this
case.

---

## What Apple asks for

Three screen recordings and one checklist:

1. **New user flow** — a person who has never taken a card payment in this app, from opening it to
   accepting one.
2. **Existing user flow** — a person who has done it before, taking another payment.
3. **Checkout flow** — the payment itself, close up: the amount, the prompt, the card, the result.
4. **The App Review Requirements Checklist** for Tap to Pay on iPhone, filled in.

Record on the phone: Settings has a screen recorder, or Control Center's record button. Portrait,
one take each, no editing needed. Narration is not required.

---

## Shot list

Record these on the cabled dev build (the one already on the phone). Use a real invoice with a
small balance — a dollar or two is fine, the same way INV-070 was.

### 1. New user flow (aim for 45-70 seconds)

| # | What to do | What Apple needs to see |
|---|---|---|
| 1 | Open North, signed out, and sign in | The app is the contractor's own tool, not a payment app |
| 2 | Go to an invoice with a balance | The bill exists before any card does |
| 3 | Tap **Pay Now** | The card door opens from ordinary work |
| 4 | Let the Tap to Pay introduction screen play through, do not skip it | That first-run explainer is the thing being reviewed |
| 5 | Accept Apple's Terms and Conditions when they appear | The terms gate is present and working |
| 6 | Let Apple's own how-to sheet appear and close it | Apple 4.2 education runs before the first tap |
| 7 | Hold the card to the top of the phone | The reader arms and reads |
| 8 | Show the result screen and the invoice now marked paid | The money lands where the bill is |

### 2. Existing user flow (aim for 25-40 seconds)

Same phone, second payment, nothing reset.

| # | What to do | What Apple needs to see |
|---|---|---|
| 1 | Open a different invoice with a balance | Normal repeat use |
| 2 | Tap **Pay Now** | No introduction, no terms, no how-to — they are already done |
| 3 | Hold the card to the phone | Straight to the reader |
| 4 | Show the result and the paid invoice | Same ending, fewer steps |

The point of this one is the *absence* of the first-run screens. Do not clear the app's data
beforehand or it becomes another new-user recording.

### 3. Checkout flow (aim for 20-30 seconds)

Closest thing to a customer's view.

| # | What to do | What Apple needs to see |
|---|---|---|
| 1 | Start from the invoice showing its balance | The amount is stated before the card is presented |
| 2 | Tap **Pay Now** and pause on the amount | The figure the customer is agreeing to |
| 3 | Present the card | The tap |
| 4 | Stay on screen through the result | Approval shown plainly |
| 5 | Show the receipt options | What the customer is offered afterwards |

### Worth capturing if it happens naturally

A **declined** card. Apple cares that a decline is reported honestly and reaches the person holding
the phone. The app pushes the decline to that person by name. If a decline is easy to produce, one
short recording of it is a strong addition. Do not fake one.

---

## Before recording

- The dev build on the phone is the right one. Its provisioning profile runs to **2027-09-11**, so
  no cable is needed to record.
- Do not install the TestFlight build first. It replaces the dev build and TestFlight has no Tap to
  Pay entitlement yet, which is the whole reason for this request.
- Use a real card. A simulated reader will not satisfy the review.
- Keep notifications quiet while recording — a text arriving mid-take means another take.

## After recording

Reply on Case-ID 22149525 with the three files and the completed checklist. Say plainly that the
development entitlement is already granted on this account and that the app is Stripe-backed
(Stripe Terminal, direct charges on the contractor's own connected account).

Then nothing is blocked on us: the entitlement is Apple's clock. When it is granted, the Tap to Pay
key moves out of `ios/App/App/AppDebug.entitlements` and into `App.entitlements`, the debug-only
file and its `CODE_SIGN_ENTITLEMENTS` override are deleted, and Xcode Cloud archives carry Tap to
Pay into TestFlight. The cable stops mattering entirely at that point.
