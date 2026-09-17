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
 * "tech" is not an oversight either: notifyGeofenceExit refuses staff outright (Erik: "push at
 * geofence for clock out only for techs"), so that switch is just as dead in an owner's hands.
 *
 * KEEP THIS HONEST — when a sender's audience changes, change the audience here in the same
 * breath, or the switch starts lying again.
 */
type Audience = "all" | "staff" | "tech";

const TRIGGERS: { key: string; label: string; help?: string; soon?: boolean; audience: Audience }[] = [
  { key: "assigned", label: "Jobs & appointments assigned to me", audience: "all" },
  { key: "inquiry", label: "New inquiries / leads", audience: "staff" },
  { key: "quote_accepted", label: "Quotes accepted by a customer", audience: "staff" },
  { key: "invoice_paid", label: "Invoices paid", audience: "staff" },
  // day_ahead's sender is LIVE (sendDayAheadDigests via /api/automations/daily) — the toggle
  // was still marked "soon" after the backend shipped. It digests to orgStaffIds.
  { key: "day_ahead", label: "My day ahead (morning summary)", audience: "staff" },
  // clock_out's sender is LIVE too (notifyGeofenceExit — fires for techs who leave the
  // job site while clocked in), so the toggle is real now. Techs only, by construction.
  { key: "clock_out", label: "Clock-out reminder (left the job site)", audience: "tech" },
  { key: "daily_report", label: "Daily reports from crew leads", audience: "staff" },
  // Its own row, not folded into "Invoices paid": Apple's Tap to Pay on iPhone requirements (the
  // launch announcement, 3.3; a decline the tech never saw, 5.12) must not go quiet as a side
  // effect of muting an unrelated alert. The help line says what it actually covers. Staff-only
  // because taking a payment is: createTapPaymentIntent runs behind requireStaff.
  {
    key: "tap_to_pay",
    label: "Tap to Pay on iPhone",
    help: "A card declined on Tap to Pay on iPhone (it buzzes even if you saw it on screen), and the one-time launch announcement.",
    audience: "staff",
  },
];
const DEFAULTS: Record<string, boolean> = {
  assigned: true,
  inquiry: true,
  quote_accepted: true,
  invoice_paid: true,
  day_ahead: false,
  clock_out: true,
  daily_report: true,
  tap_to_pay: true,
};

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
}: {
  initialPrefs: Record<string, boolean>;
  /** The viewer's role, when the server already has it. Left out, this asks for it once. */
  role?: string | null;
}) {
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

  useEffect(() => {
    if (initialRole) return;
    let live = true;
    myNotificationRole().then(
      (r) => {
        if (!live) return;
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
        if (live) setRoleUnknown(true);
      },
    );
    return () => {
      live = false;
    };
  }, [initialRole]);

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
        setMsg(saved.error ?? "Could not register this phone."); setMsgBad(true);
        setBusy(false);
        return;
      }
      setDeviceToken(r.token);
      setEnabled(true);
      setMsg("Notifications are on for this phone."); setMsgBad(false);
      setBusy(false);
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg("Notifications were blocked — enable them in your browser settings to receive alerts."); setMsgBad(true);
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
        setMsg(res.error ?? "Could not save the subscription."); setMsgBad(true);
        setBusy(false);
        return;
      }
      setEnabled(true);
      setMsg("Notifications are on for this device."); setMsgBad(false);
    } catch (e: any) {
      setMsg(e?.message ?? "Could not enable notifications."); setMsgBad(true);
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
        setMsg(res.error ?? "Couldn't turn this phone off on the server — try again."); setMsgBad(true);
        setBusy(false);
        return;
      }
      setDeviceToken(null);
      setEnabled(false);
      setMsg("This phone won't be sent notifications. iPhone Settings → North still shows them as allowed."); setMsgBad(false);
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
      setMsg("Turned off for this device."); setMsgBad(false);
    } catch (e: any) {
      setMsg(e?.message ?? "Could not turn off."); setMsgBad(true);
    }
    setBusy(false);
  }

  function toggle(key: string) {
    const next = { ...prefs, [key]: !(prefs[key] ?? DEFAULTS[key]) };
    setPrefs(next);
    savePushPrefs(next);
  }

  if (!supported)
    return (
      <p className="text-sm text-slate-500">
        {native
          ? "This version of the app can't do notifications yet — update North from TestFlight."
          : "This browser doesn't support push notifications."}
      </p>
    );
  if (!configured)
    return (
      <p className="text-sm text-slate-500">
        Push isn&apos;t switched on for your company yet (the server key hasn&apos;t been added). Once
        it&apos;s in, you&apos;ll be able to enable notifications on each device right here.
      </p>
    );

  // Until the role is known, only the alerts every role receives — never a switch that can't work.
  const visibleTriggers = TRIGGERS.filter((t) => {
    if (t.audience === "all") return true;
    if (!role) return false;
    return t.audience === "staff" ? isStaffRole(role) : !isStaffRole(role);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900">Notifications on this device</div>
          <div className="text-xs text-slate-500">
            {enabled
              ? "On — you'll get the alerts you've turned on below."
              : native
                ? "Off — turn on to get alerts on this phone."
                : "Off — turn on to get alerts on this device."}
          </div>
        </div>
        <Button onClick={enabled ? disable : enable} disabled={busy} variant={enabled ? "outline" : "primary"}>
          {busy ? "…" : enabled ? "Turn Off" : "Enable"}
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
        {visibleTriggers.map((t) => (
          <label
            key={t.key}
            className={`flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm ${t.soon ? "opacity-60" : ""}`}
          >
            <span className="text-slate-700">
              {t.label}
              {t.soon && (
                <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">soon</span>
              )}
              {t.help && <span className="block text-xs text-slate-500">{t.help}</span>}
            </span>
            <input
              type="checkbox"
              disabled={t.soon}
              checked={prefs[t.key] ?? DEFAULTS[t.key]}
              onChange={() => toggle(t.key)}
              className="h-4 w-4 accent-brand"
            />
          </label>
        ))}
        {!role && !roleUnknown && <p className="text-xs text-slate-400">Loading the rest of your alerts…</p>}
        {roleUnknown && (
          <p className="text-xs text-red-600">
            We couldn&apos;t check your role, so only the alerts everyone gets are listed. Reload the page to see the rest.
          </p>
        )}
      </div>
    </div>
  );
}
