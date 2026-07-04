"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { syncScheduleToGoogle, disconnectGoogleCalendar } from "./actions";

/** Google Calendar connection status + one-tap schedule push. */
export function GcalCard({
  configured,
  connected,
  flash,
}: {
  configured: boolean;
  connected: boolean;
  flash?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(
    flash === "connected" ? "Connected to Google Calendar." : flash === "error" || flash === "denied" ? "Could not connect — try again." : null,
  );

  function sync() {
    setMsg(null);
    start(async () => {
      const res = await syncScheduleToGoogle();
      setMsg(res.ok ? `Pushed ${res.synced ?? 0} scheduled job${(res.synced ?? 0) === 1 ? "" : "s"} to Google Calendar.` : res.error ?? "Sync failed.");
      router.refresh();
    });
  }

  function disconnect() {
    if (!confirm("Disconnect Google Calendar? Existing events stay in your calendar.")) return;
    start(async () => {
      await disconnectGoogleCalendar();
      setMsg("Disconnected.");
      router.refresh();
    });
  }

  if (!configured) {
    return (
      <p className="text-sm text-slate-400">
        Add <code>GOOGLE_OAUTH_CLIENT_ID</code> and <code>GOOGLE_OAUTH_CLIENT_SECRET</code> to the
        server environment to enable Google Calendar sync.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {msg && <div className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{msg}</div>}
      {connected ? (
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone="green">Connected</Badge>
          <Button size="sm" onClick={sync} disabled={pending}>
            <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
            Push Schedule to Google
          </Button>
          <Button size="sm" variant="outline" onClick={disconnect} disabled={pending}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div>
          <a
            href="/api/google/connect"
            className="inline-flex items-center gap-2 rounded-lg bg-[rgb(var(--glass-ink))] px-4 py-2 text-sm font-medium text-white hover:bg-[rgb(var(--glass-ink))]/90"
          >
            <CalendarCheck className="h-4 w-4 shrink-0" /> Connect Google Calendar
          </a>
          <p className="mt-2 text-xs text-slate-400">
            Scheduled jobs (next 60 days) push to your calendar as events — re-run the push after
            schedule changes.
          </p>
        </div>
      )}
    </div>
  );
}
