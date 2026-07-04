"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { savePushSubscription, removePushSubscription, savePushPrefs } from "./push-actions";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

const TRIGGERS: { key: string; label: string; soon?: boolean }[] = [
  { key: "assigned", label: "Jobs & appointments assigned to me" },
  { key: "inquiry", label: "New inquiries / leads" },
  { key: "quote_accepted", label: "Quotes accepted by a customer" },
  { key: "invoice_paid", label: "Invoices paid" },
  { key: "day_ahead", label: "My day ahead (morning summary)", soon: true },
  { key: "clock_out", label: "Clock-out reminder", soon: true },
];
const DEFAULTS: Record<string, boolean> = {
  assigned: true,
  inquiry: true,
  quote_accepted: true,
  invoice_paid: true,
  day_ahead: false,
  clock_out: false,
};

function urlB64ToUint8(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function PushSettings({ initialPrefs }: { initialPrefs: Record<string, boolean> }) {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<string, boolean>>(initialPrefs ?? {});

  useEffect(() => {
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

  const configured = !!PUBLIC_KEY;

  async function enable() {
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg("Notifications were blocked — enable them in your browser settings to receive alerts.");
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
        setMsg(res.error ?? "Could not save the subscription.");
        setBusy(false);
        return;
      }
      setEnabled(true);
      setMsg("Notifications are on for this device.");
    } catch (e: any) {
      setMsg(e?.message ?? "Could not enable notifications.");
    }
    setBusy(false);
  }

  async function disable() {
    setBusy(true);
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await removePushSubscription(sub.endpoint);
        await sub.unsubscribe();
      }
      setEnabled(false);
      setMsg("Turned off for this device.");
    } catch (e: any) {
      setMsg(e?.message ?? "Could not turn off.");
    }
    setBusy(false);
  }

  function toggle(key: string) {
    const next = { ...prefs, [key]: !(prefs[key] ?? DEFAULTS[key]) };
    setPrefs(next);
    savePushPrefs(next);
  }

  if (!supported)
    return <p className="text-sm text-slate-500">This browser doesn&apos;t support push notifications.</p>;
  if (!configured)
    return (
      <p className="text-sm text-slate-500">
        Push isn&apos;t switched on for your company yet (the server key hasn&apos;t been added). Once
        it&apos;s in, you&apos;ll be able to enable notifications on each device right here.
      </p>
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900">Notifications on this device</div>
          <div className="text-xs text-slate-500">
            {enabled ? "On — you'll get the alerts you've turned on below." : "Off — turn on to get alerts on this device."}
          </div>
        </div>
        <Button onClick={enabled ? disable : enable} disabled={busy} variant={enabled ? "outline" : "primary"}>
          {busy ? "…" : enabled ? "Turn Off" : "Enable"}
        </Button>
      </div>
      {msg && <p className="text-xs text-slate-500">{msg}</p>}

      <div className="space-y-2">
        {TRIGGERS.map((t) => (
          <label
            key={t.key}
            className={`flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm ${t.soon ? "opacity-60" : ""}`}
          >
            <span className="text-slate-700">
              {t.label}
              {t.soon && (
                <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">soon</span>
              )}
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
      </div>
    </div>
  );
}
