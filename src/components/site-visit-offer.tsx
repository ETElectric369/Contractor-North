"use client";

import { useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import {
  publicPickInspectionTime,
  publicScheduleInspection,
  type OfferedTime,
  type PublicPickResult,
  type PublicScheduleResult,
} from "@/lib/actions/public-schedule";
import {
  ADDRESS_FIRST,
  ADDRESS_PLACEHOLDER,
  NONE_OF_THESE_WORK,
  OFFER_A_SITE_VISIT,
  PICK_A_TIME_HEADING,
  SITE_VISIT_REQUESTED,
  TIME_JUST_TAKEN,
  WHERE_SHOULD_WE_COME,
  bookedSentence,
} from "@/app/inquire/site-visit-words";

/**
 * A WEBSITE VISITOR PICKS AN OPEN INSPECTION TIME (cn-v1185). The owner: "offer open times". A
 * company that ticked its Inspection Days gets, on every public form's thank-you, the open times
 * the server found (the request door's answer); the visitor TAPS ONE and that tap books it. The
 * server asks the calendar again at the tap, so a time can come back "just taken" with fresh times.
 * The app never books by itself, and None of These Work sends the office the old request instead.
 *
 * What a customer reads is English literals from site-visit-words.ts (a public page imports no
 * catalog). The only key sent is the lead id THIS browser's own submit returned (audit A6).
 *
 * The screens are a pure function of `OfferState` (SiteVisitOfferView) and every tap's next state
 * is worked out by an exported async step (pickTime, giveUp, askForTimes), so the unit project,
 * which has no DOM, draws each screen and drives each step with the server actions stood in for.
 */

/** Said when the call itself never came back (a dropped connection), at either tap. */
export const DIDNT_GO_THROUGH = "That didn't go through. Try again, or call us.";

export type OfferContact = { name: string; phone?: string; email?: string; address?: string };

export type OfferState =
  | { kind: "pick"; times: OfferedTime[]; taken: boolean; error: string | null }
  | { kind: "booked"; label: string }
  | { kind: "requested" };

type Where = { handle?: string; orgId?: string; leadId: string | null };

/** What the pick tap's answer turns the panel into. */
export function stateAfterPick(res: PublicPickResult, times: OfferedTime[]): OfferState {
  if (res.booked) return { kind: "booked", label: res.booked.label };
  if (res.taken && res.times && res.times.length > 0) return { kind: "pick", times: res.times, taken: true, error: null };
  if (res.ok) return { kind: "requested" };
  return { kind: "pick", times, taken: false, error: res.error ?? DIDNT_GO_THROUGH };
}

/** The fewest characters a typed address may have before a tap sends it. */
const ADDRESS_MIN = 5;

/**
 * One tap on a time. Never throws: a call that did not come back keeps the buttons and says so.
 * `ask` is given only when the panel asked where to come (the contact had no address, skeptic #87
 * S10): fewer than five characters typed makes NO call and says to add the address first; otherwise
 * the typed address rides with the tap.
 */
export async function pickTime(
  where: Where,
  at: string,
  times: OfferedTime[],
  ask?: { address: string },
): Promise<OfferState> {
  const typed = ask ? ask.address.trim() : "";
  if (ask && typed.length < ADDRESS_MIN) return { kind: "pick", times, taken: false, error: ADDRESS_FIRST };
  try {
    const res = await publicPickInspectionTime({
      handle: where.handle,
      orgId: where.orgId,
      leadId: where.leadId,
      at,
      ...(ask ? { address: typed } : {}),
    });
    return stateAfterPick(res, times);
  } catch {
    return { kind: "pick", times, taken: false, error: DIDNT_GO_THROUGH };
  }
}

/** None of These Work: the office is asked to send times, and no times are offered again. */
export async function giveUp(where: Where, contact: OfferContact, times: OfferedTime[]): Promise<OfferState> {
  try {
    const res: PublicScheduleResult = await publicScheduleInspection({
      handle: where.handle,
      orgId: where.orgId,
      leadId: where.leadId,
      ...contact,
      noOffer: true,
    });
    if (res.ok) return { kind: "requested" };
    return { kind: "pick", times, taken: false, error: res.error ?? DIDNT_GO_THROUGH };
  } catch {
    return { kind: "pick", times, taken: false, error: DIDNT_GO_THROUGH };
  }
}

const timeBtn =
  "flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-60";

/** The panel, drawn from its state. `busy` is the `at` being booked, or "none" while giving up. */
export function SiteVisitOfferView({
  state,
  busy,
  onPick,
  onGiveUp,
  ask,
}: {
  state: OfferState;
  busy: string | null;
  onPick: (at: string) => void;
  onGiveUp: () => void;
  /** Given only when the contact has no address: the box above the times that asks where to come. */
  ask?: { address: string; onAddress: (v: string) => void };
}) {
  if (state.kind === "booked")
    return <p className="mt-5 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-700">{bookedSentence(state.label)}</p>;
  if (state.kind === "requested")
    return <p className="mt-5 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">{SITE_VISIT_REQUESTED}</p>;
  return (
    <div className="mt-5 text-left">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <CalendarClock className="h-4 w-4" /> {PICK_A_TIME_HEADING}
      </p>
      {state.taken && <p className="mt-1 text-sm text-slate-600">{TIME_JUST_TAKEN}</p>}
      {ask && (
        <label className="mt-3 block text-sm font-medium text-slate-700">
          {WHERE_SHOULD_WE_COME}
          <input
            type="text"
            value={ask.address}
            onChange={(e) => ask.onAddress(e.target.value)}
            placeholder={ADDRESS_PLACEHOLDER}
            autoComplete="street-address"
            maxLength={300}
            disabled={busy !== null}
            className="mt-1 block min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 disabled:opacity-60"
          />
        </label>
      )}
      <div className="mt-3 grid gap-2">
        {state.times.map((t) => (
          <button key={t.at} type="button" disabled={busy !== null} onClick={() => onPick(t.at)} className={timeBtn}>
            {busy === t.at ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy === t.at ? "One Moment…" : t.label}
          </button>
        ))}
      </div>
      {state.error && <p className="mt-2 text-sm text-red-600">{state.error}</p>}
      <button
        type="button"
        disabled={busy !== null}
        onClick={onGiveUp}
        className="mt-2 flex min-h-[44px] w-full items-center justify-center text-sm text-slate-500 underline-offset-2 hover:underline disabled:opacity-60"
      >
        {busy === "none" ? "One Moment…" : NONE_OF_THESE_WORK}
      </button>
    </div>
  );
}

/** The open times a request door answered with; one tap books one. */
export function SiteVisitOffer(props: {
  handle?: string;
  orgId?: string;
  leadId: string | null;
  contact: OfferContact;
  times: OfferedTime[];
  onGaveUp?: () => void;
}) {
  const [state, setState] = useState<OfferState>({ kind: "pick", times: props.times, taken: false, error: null });
  const [busy, setBusy] = useState<string | null>(null);
  // LAST, always: the static draws seed a form's state by call order (seed-state.test-support).
  const [address, setAddress] = useState("");
  const where: Where = { handle: props.handle, orgId: props.orgId, leadId: props.leadId };
  const shown = state.kind === "pick" ? state.times : [];
  // No address on the contact (the hosted site's contact form asks none): ask where to come.
  const askAddress = !String(props.contact.address ?? "").trim();

  async function onPick(at: string) {
    if (busy) return;
    if (askAddress && address.trim().length < ADDRESS_MIN) {
      // No call is made; the panel keeps what it showed ("just taken" too) and says what to do.
      const next = await pickTime(where, at, shown, { address });
      setState(state.kind === "pick" && next.kind === "pick" ? { ...state, error: next.error } : next);
      return;
    }
    setBusy(at);
    const next = await pickTime(where, at, shown, askAddress ? { address } : undefined);
    setState(next);
    setBusy(null);
  }

  async function onGiveUp() {
    if (busy) return;
    setBusy("none");
    const next = await giveUp(where, props.contact, shown);
    setState(next);
    setBusy(null);
    if (next.kind === "requested") props.onGaveUp?.();
  }

  return (
    <SiteVisitOfferView
      state={state}
      busy={busy}
      onPick={onPick}
      onGiveUp={onGiveUp}
      ask={askAddress ? { address, onAddress: setAddress } : undefined}
    />
  );
}

/** What the door's tap turns into: the offer, the request sentence, or a refusal beside the button. */
export type DoorState =
  | { kind: "idle"; error: string | null }
  | { kind: "offer"; times: OfferedTime[] }
  | { kind: "requested" };

/** The door's tap: the request door with the contact just typed and the lead this submit wrote. */
export async function askForTimes(where: Where, contact: OfferContact): Promise<DoorState> {
  try {
    const res = await publicScheduleInspection({ handle: where.handle, orgId: where.orgId, leadId: where.leadId, ...contact });
    if (!res.ok) return { kind: "idle", error: res.error ?? DIDNT_GO_THROUGH };
    if (res.times && res.times.length > 0) return { kind: "offer", times: res.times };
    return { kind: "requested" };
  } catch {
    return { kind: "idle", error: DIDNT_GO_THROUGH };
  }
}

/** The door drawn from its state (pure, for the static draws). */
export function SiteVisitDoorView({
  state,
  busy,
  brand,
  where,
  contact,
  onAsk,
}: {
  state: DoorState;
  busy: boolean;
  brand: string;
  where: Where;
  contact: OfferContact;
  onAsk: () => void;
}) {
  if (state.kind === "offer")
    return <SiteVisitOffer handle={where.handle} orgId={where.orgId} leadId={where.leadId} contact={contact} times={state.times} />;
  if (state.kind === "requested")
    return <p className="mt-5 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">{SITE_VISIT_REQUESTED}</p>;
  return (
    <>
      <button
        type="button"
        onClick={onAsk}
        disabled={busy}
        className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
        style={{ backgroundColor: brand }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
        {busy ? "One Moment…" : OFFER_A_SITE_VISIT}
      </button>
      {state.error && <p className="mt-2 text-sm text-red-600">{state.error}</p>}
    </>
  );
}

/**
 * THE ONE NEW BUTTON on a form that never had Request a Site Visit (the hosted site's contact form,
 * the intake form). Its form draws it only when the company offers times AND this submit returned
 * its own lead id, so a company with the offer off sees its form exactly as before.
 */
export function SiteVisitDoor({
  handle,
  orgId,
  leadId,
  contact,
  brand,
}: {
  handle?: string;
  orgId?: string;
  leadId: string;
  contact: OfferContact;
  /** The company's colour; a form without one (the intake form) gets the house dark. */
  brand?: string;
}) {
  const [state, setState] = useState<DoorState>({ kind: "idle", error: null });
  const [busy, setBusy] = useState(false);
  const where: Where = { handle, orgId, leadId };

  async function onAsk() {
    if (busy) return;
    setBusy(true);
    setState({ kind: "idle", error: null });
    const next = await askForTimes(where, contact);
    setState(next);
    setBusy(false);
  }

  return <SiteVisitDoorView state={state} busy={busy} brand={brand ?? "#0f172a"} where={where} contact={contact} onAsk={onAsk} />;
}
