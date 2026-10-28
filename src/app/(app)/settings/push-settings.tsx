"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  savePushSubscription,
  removePushSubscription,
  savePushPrefs,
  saveDeviceToken,
  removeDeviceToken,
  myNotificationRole,
} from "./push-actions";
import { isNativeShell } from "@/lib/native-shell";
import { isStaffRole } from "@/lib/actions/perms";
import { registerForNativePush, nativePushPermission } from "@/lib/native-push";
import { LONG_SHIFT_HOURS } from "@/lib/long-shift";
import { featureOn, type FeatureKey, type FeatureMap } from "@/lib/features";
import { fillText, translator, type Lang } from "@/lib/i18n";
import { useLang } from "@/components/lang-provider";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

/**
 * WHO CAN ACTUALLY RECEIVE THIS ALERT (2026-09-16).
 *
 * Every toggle here was shown to everybody, including the six whose senders only ever address
 * office staff (orgStaffIds / the staff list in quotes, timeclock and billing). A tech could
 * switch "Invoices paid" on and wait forever: the alert is never addressed to them, so the switch
 * changed nothing. A control a role cannot use must not render — so each trigger now names its
 * audience and the list is filtered by the viewer's role.
 *
 * "tech" is kept for an alert only crew can receive. clock_out was one (notifyGeofenceExit refuses
 * staff outright, Erik: "push at geofence for clock out only for techs") until the hourly long-shift
 * job began asking anybody whose own clock ran LONG_SHIFT_HOURS (2026-09-24); now it is "all".
 *
 * KEEP THIS HONEST — when a sender's audience changes, change the audience here in the same
 * breath, or the switch starts lying again.
 */
// "platform" (cn-v1136): North's own team, never a company role — is_platform_admin() answers it
// (0176), and nobody else is ever addressed under its kind, so nobody else sees its switch.
// "admins" (cn-v1137): the owner and the admins only — the billing notices (lib/billing-notices and
// the Stripe webhook's declined-card line) are addressed to role owner/admin, so the office, which
// can neither pick a plan nor update the card, never sees a switch for a buzz it cannot receive.
type Audience = "all" | "staff" | "tech" | "platform" | "admins";

/**
 * AND THE SWITCH BOARD (0352). `feature`: an alert only a switched-on feature sends, so its switch
 * goes with it (with Daily Reports off no report is filed, and a switch that can never fire is a
 * dead door). `whenOff`: an alert that KEEPS COMING with its feature off, reworded: a request from
 * the website still buzzes with Leads off (it lands on My Day), so its switch stays, in plain
 * words. "Quotes accepted" carries neither on purpose: an estimate already sent can still be
 * accepted with Estimates off, and that buzz is worth keeping (and muting).
 */
// THE WORDS LIVE IN THE CATALOG (cn-v1138, lib/words/shell.ts): a kind's label is sh_push_<kind>, its
// line sh_pushHelp_<kind> (`help: true` says it has one), and its words with the feature off
// sh_pushOff_<kind>; pushTriggersFor fills them in for the viewer's language, English by default.
// {hours} in a label or a line is LONG_SHIFT_HOURS.
const TRIGGERS: { key: string; help?: boolean; soon?: boolean; audience: Audience; feature?: FeatureKey; whenOff?: { feature: FeatureKey } }[] = [
  { key: "assigned", audience: "all" },
  { key: "inquiry", audience: "staff", whenOff: { feature: "leads" } },
  { key: "quote_accepted", audience: "staff" },
  { key: "invoice_paid", audience: "staff" },
  // day_ahead's sender is LIVE (sendDayAheadDigests via /api/automations/daily) — the toggle
  // was still marked "soon" after the backend shipped. It digests to orgStaffIds.
  { key: "day_ahead", audience: "staff" },
  // clock_out has TWO senders: notifyGeofenceExit (techs who leave the job site while clocked in,
  // refused for staff) and the hourly long-shift job, which asks ANYONE whose own clock has run
  // LONG_SHIFT_HOURS. So everybody can receive it, and everybody gets the switch.
  { key: "clock_out", help: true, audience: "all" },
  // The office's buzz about a crew member's clock still running at LONG_SHIFT_HOURS; the bell line
  // at OFFICE_BELL_HOURS is not a push and has no switch.
  { key: "long_shift", help: true, audience: "staff" },
  { key: "daily_report", audience: "staff", feature: "daily_reports" },
  // A customer picked one of the times the office texted them (/api/pick/confirmed → orgStaffIds).
  // The kind had been on by default with no switch here since the pick link shipped (found by the
  // DEFAULTS mirror pin, cn-v1137): a buzz nobody could turn off.
  { key: "booked", help: true, audience: "staff" },
  // Its own row, not folded into "Invoices paid": Apple's Tap to Pay on iPhone requirements (the
  // launch announcement, 3.3; a decline the tech never saw, 5.12) must not go quiet as a side
  // effect of muting an unrelated alert. The help line says what it actually covers. Staff-only
  // because taking a payment is: createTapPaymentIntent runs behind requireStaff.
  { key: "tap_to_pay", help: true, audience: "staff" },
  // The company's standing with North (cn-v1137): the trial's last days, a declined card and the
  // day a plan ends (lib/billing-notices from the daily cron; the Stripe webhook's declined-card
  // line). Addressed to the owner and admins only, so only they see the switch.
  { key: "billing", help: true, audience: "admins" },
  // North's own team only (cn-v1136): the blocker page (observe-blocker → platform-alert) and the
  // Monday digest (bug-watch-digest) ride the bug_watch kind. A company member never receives it,
  // so a company member never sees the switch.
  { key: "bug_watch", help: true, audience: "platform" },
];
// A hand copy of lib/push.ts's DEFAULTS (that file is server-only): keep the two the same.
const DEFAULTS: Record<string, boolean> = {
  assigned: true,
  inquiry: true,
  quote_accepted: true,
  invoice_paid: true,
  day_ahead: false,
  clock_out: true,
  daily_report: true,
  booked: true,
  tap_to_pay: true,
  long_shift: true,
  bug_watch: true,
  billing: true,
};

/** The roles the billing notices are addressed to: the people who can pick a plan or update the
 *  card. The senders read profiles with the same two roles (lib/billing-notices, the webhook). */
const ADMIN_ROLES = ["owner", "admin"];

/** The alert switches this person sees: by role (until the role is known, only the alerts every
 *  role receives — never a switch that can't work), then by the company's feature switches; the
 *  platform row only for a platform admin, whatever their company role. */
export function pushTriggersFor(role: string | null, features?: FeatureMap | null, platformAdmin = false, lang: Lang = "en") {
  const t = translator(lang);
  const hours = { hours: String(LONG_SHIFT_HOURS) };
  return TRIGGERS.filter((row) => {
    if (row.feature && !featureOn(features, row.feature)) return false;
    if (row.audience === "platform") return platformAdmin;
    if (row.audience === "all") return true;
    if (!role) return false;
    if (row.audience === "admins") return ADMIN_ROLES.includes(role);
    return row.audience === "staff" ? isStaffRole(role) : !isStaffRole(role);
  }).map((row) => {
    const off = row.whenOff && !featureOn(features, row.whenOff.feature);
    const label = fillText(t(off ? `sh_pushOff_${row.key}` : `sh_push_${row.key}`), hours);
    const help = row.help ? fillText(t(`sh_pushHelp_${row.key}`), hours) : undefined;
    return { ...row, label, help };
  });
}

function urlB64ToUint8(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function PushSettings({
  initialPrefs,
  role: initialRole,
  features,
  platformAdmin: initialPlatformAdmin,
}: {
  initialPrefs: Record<string, boolean>;
  /** The company's switches (0352): an alert that only a switched-off feature sends isn't offered. */
  features?: FeatureMap;
  /** The viewer's role, when the server already has it. Left out, this asks for it once. */
  role?: string | null;
  /** Whether the viewer is one of North's own (cn-v1136), when the server already knows. Left out,
   *  the same one ask that fetches the role answers it; until it lands, the platform row is not drawn. */
  platformAdmin?: boolean;
  /** Alerts whose feature is switched off (0352): not drawn. The stored choice is kept. */
  hiddenKeys?: string[];
}) {
  // The switches' words in the person's language (cn-v1138).
  const lang = useLang();
  const t = translator(lang);
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // A FAILURE HAS TO LOOK LIKE ONE (2026-09-09). Every outcome — "turned on", "iOS said no",
  // "stuck at waiting for Apple" — rendered as the same 12px grey line under the button, so a
  // real error read as nothing at all: the button just went back to Enable and the reason sat
  // there unread. NOTHING SILENT means the failure is legible, not merely present.
  const [msgBad, setMsgBad] = useState(false);
  const [prefs, setPrefs] = useState<Record<string, boolean>>(initialPrefs ?? {});
  // TWO TRANSPORTS (2026-09-09). In the App Store app there is no service worker and no
  // PushManager — Apple's Web Push is Safari / home-screen only — so this used to render
  // "This browser doesn't support push notifications", the word "browser", inside an app, and
  // every alert the product sends went to the PWA and not the app. The shell registers with
  // APNs instead; the toggles below are shared because the server honours them either way.
  const [native, setNative] = useState(false);
  // The APNs token for THIS phone, held so Turn Off knows which row to delete.
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  // The viewer's role decides which toggles are real for them (see TRIGGERS above).
  const [role, setRole] = useState<string | null>(initialRole ?? null);
  const [roleUnknown, setRoleUnknown] = useState(false);
  // North's own team sees one more row (cn-v1136). Known from the server when the page passed it;
  // otherwise learned by the same ask as the role. A company member is never one, so for them a
  // lost answer changes nothing on the screen.
  const [platformAdmin, setPlatformAdmin] = useState<boolean>(initialPlatformAdmin ?? false);

  useEffect(() => {
    // Nothing left to ask: the server handed over both the role and the platform answer. The page
    // passes both (skeptic #42, S8), so the action is never called from a settings visit; a mount
    // that leaves either out — and only such a mount — asks once.
    if (initialRole && typeof initialPlatformAdmin === "boolean") return;
    let live = true;
    myNotificationRole().then(
      (r) => {
        if (!live) return;
        if (typeof initialPlatformAdmin !== "boolean") setPlatformAdmin(r.platformAdmin === true);
        if (initialRole) return;
        if (r.ok && r.role) setRole(r.role);
        // NOT A DEAD END: we fall back to the alerts everyone gets and say why the rest are missing,
        // rather than guessing a role and rendering switches that do nothing.
        else setRoleUnknown(true);
      },
      // AND A REJECTION IS NOT A THIRD STATE (audit, 2026-09-17). Without this the .then never
      // ran on a dropped connection, so neither setRole nor setRoleUnknown fired: role stayed
      // null, roleUnknown stayed false, and the role-gated toggles simply were not there, with
      // no sentence saying why. On a jobsite that is the common case, not the rare one.
      () => {
        if (live && !initialRole) setRoleUnknown(true);
      },
    );
    return () => {
      live = false;
    };
  }, [initialRole, initialPlatformAdmin]);

  useEffect(() => {
    const inShell = isNativeShell();
    setNative(inShell);
    if (inShell) {
      // The OS is the source of truth for whether this phone is allowed to buzz. A token we
      // stored earlier is worthless once someone switched North off in iPhone Settings.
      nativePushPermission().then((p) => {
        setSupported(p !== null);
        setEnabled(p === "granted");
      });
      return;
    }
    const ok =
      typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
    setSupported(ok);
    if (ok) {
      navigator.serviceWorker.ready
        .then((r) => r.pushManager.getSubscription())
        .then((s) => setEnabled(!!s))
        .catch(() => {});
    }
  }, []);

  // The VAPID key is the WEB transport's config. APNs is configured on the server (its signing
  // key never reaches the browser), so the shell must not be gated on a key it doesn't use.
  const configured = native || !!PUBLIC_KEY;

  async function enable() {
    setBusy(true);
    setMsg(null);
    if (native) {
      const r = await registerForNativePush();
      if (!r.ok) {
        setMsg(r.error); setMsgBad(true);
        setBusy(false);
        return;
      }
      const saved = await saveDeviceToken(r.token, navigator.userAgent);
      if (!saved.ok) {
        setMsg(saved.error ?? t("sh_pushCouldNotRegister")); setMsgBad(true);
        setBusy(false);
        return;
      }
      setDeviceToken(r.token);
      setEnabled(true);
      setMsg(t("sh_pushOnForPhone")); setMsgBad(false);
      setBusy(false);
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg(t("sh_pushBlocked")); setMsgBad(true);
        setBusy(false);
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8(PUBLIC_KEY!),
      });
      const res = await savePushSubscription(sub.toJSON() as any, navigator.userAgent);
      if (!res.ok) {
        setMsg(res.error ?? t("sh_pushCouldNotSaveSub")); setMsgBad(true);
        setBusy(false);
        return;
      }
      setEnabled(true);
      setMsg(t("sh_pushOnForDevice")); setMsgBad(false);
    } catch (e: any) {
      setMsg(e?.message ?? t("sh_pushCouldNotEnable")); setMsgBad(true);
    }
    setBusy(false);
  }

  async function disable() {
    setBusy(true);
    setMsg(null);
    if (native) {
      // iOS gives no way to hand a permission back, so "off" here means: stop sending to this
      // phone. Say exactly that rather than implying the OS switch moved. If the token isn't in
      // hand (a fresh page load after enabling on a previous visit), re-registering is the only
      // way to learn it — that's silent and prompts nothing, the permission is already granted.
      let token = deviceToken;
      if (!token) {
        const r = await registerForNativePush();
        if (r.ok) token = r.token;
      }
      const res = token ? await removeDeviceToken(token) : { ok: false, error: undefined };
      if (!res.ok) {
        setMsg(res.error ?? t("sh_pushCouldNotTurnOffPhone")); setMsgBad(true);
        setBusy(false);
        return;
      }
      setDeviceToken(null);
      setEnabled(false);
      setMsg(t("sh_pushPhoneOff")); setMsgBad(false);
      setBusy(false);
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await removePushSubscription(sub.endpoint);
        await sub.unsubscribe();
      }
      setEnabled(false);
      setMsg(t("sh_pushOffForDevice")); setMsgBad(false);
    } catch (e: any) {
      setMsg(e?.message ?? t("sh_pushCouldNotTurnOff")); setMsgBad(true);
    }
    setBusy(false);
  }

  function toggle(key: string) {
    const next = { ...prefs, [key]: !(prefs[key] ?? DEFAULTS[key]) };
    setPrefs(next);
    savePushPrefs(next);
  }

  if (!supported) return <p className="text-sm text-slate-500">{native ? t("sh_pushNotSupportedApp") : t("sh_pushNotSupportedBrowser")}</p>;
  if (!configured) return <p className="text-sm text-slate-500">{t("sh_pushNotConfigured")}</p>;

  const visibleTriggers = pushTriggersFor(role, features, platformAdmin, lang);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900">{t("sh_pushOnThisDevice")}</div>
          <div className="text-xs text-slate-500">{enabled ? t("sh_pushOnLine") : native ? t("sh_pushOffPhoneLine") : t("sh_pushOffDeviceLine")}</div>
        </div>
        <Button onClick={enabled ? disable : enable} disabled={busy} variant={enabled ? "outline" : "primary"}>
          {busy ? "…" : enabled ? t("sh_turnOff") : t("sh_enable")}
        </Button>
      </div>
      {msg && (
        <p
          className={
            msgBad
              ? "rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
              : "rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          }
        >
          {msg}
        </p>
      )}

      <div className="space-y-2">
        {visibleTriggers.map((row) => (
          <label
            key={row.key}
            className={`flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm ${row.soon ? "opacity-60" : ""}`}
          >
            <span className="text-slate-700">
              {row.label}
              {row.soon && (
                <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">{t("sh_soon")}</span>
              )}
              {row.help && <span className="block text-xs text-slate-500">{row.help}</span>}
            </span>
            <input
              type="checkbox"
              disabled={row.soon}
              checked={prefs[row.key] ?? DEFAULTS[row.key]}
              onChange={() => toggle(row.key)}
              className="h-4 w-4 accent-brand"
            />
          </label>
        ))}
        {!role && !roleUnknown && <p className="text-xs text-slate-400">{t("sh_pushLoadingRest")}</p>}
        {roleUnknown && <p className="text-xs text-red-600">{t("sh_pushRoleUnknown")}</p>}
      </div>
    </div>
  );
}
