"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  syncScheduleToGoogle,
  disconnectGoogleCalendar,
  listGoogleCalendars,
  saveSelectedCalendars,
  syncGoogleNow,
} from "./actions";

interface CalOption {
  id: string;
  summary: string;
  primary?: boolean;
}

/** Google Calendar connection: status, the two-way calendar picker (which of
 *  the account's calendars mirror into the schedule read-only), Sync now, the
 *  legacy one-tap full push, and Disconnect. */
export function GcalCard({
  configured,
  connected,
  flash,
  selectedCalendars = [],
  lastSyncedAt = null,
}: {
  configured: boolean;
  connected: boolean;
  flash?: string;
  /** calendar_connections.selected_calendars — the mirrored calendar ids. */
  selectedCalendars?: string[];
  /** calendar_connections.last_synced_at (ISO) — shown as "Last synced". */
  lastSyncedAt?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(
    flash === "connected" ? "Connected to Google Calendar." : flash === "error" || flash === "denied" ? "Could not connect — try again." : null,
  );

  // Calendar picker: loaded from Google on demand (not on every settings render).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<CalOption[] | null>(null);
  const [chosen, setChosen] = useState<string[]>(selectedCalendars);

  function togglePicker() {
    if (pickerOpen) return setPickerOpen(false);
    setPickerOpen(true);
    if (options) return;
    start(async () => {
      const res = await listGoogleCalendars();
      if (!res.ok || !res.calendars) {
        setMsg(res.error ?? "Couldn't load calendars.");
        setPickerOpen(false);
        return;
      }
      // Selected-but-no-longer-listed ids stay visible so they can be unticked.
      const known = new Set(res.calendars.map((c) => c.id));
      const stale = chosen.filter((id) => !known.has(id)).map((id) => ({ id, summary: id }));
      setOptions([...res.calendars, ...stale]);
    });
  }

  function toggleCalendar(id: string) {
    setChosen((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  function savePicker() {
    setMsg(null);
    start(async () => {
      const res = await saveSelectedCalendars(chosen);
      if (!res.ok) return setMsg(res.error ?? "Couldn't save.");
      setMsg(
        chosen.length
          ? `Mirroring ${chosen.length} calendar${chosen.length === 1 ? "" : "s"} — events appear on the schedule after the next sync.`
          : "No calendars mirrored.",
      );
      router.refresh();
    });
  }

  function syncNow() {
    setMsg(null);
    start(async () => {
      const res = await syncGoogleNow();
      setMsg(
        res.ok
          ? `Synced — pulled ${res.pulled ?? 0} Google event${(res.pulled ?? 0) === 1 ? "" : "s"}, pushed ${res.swept ?? 0} item${(res.swept ?? 0) === 1 ? "" : "s"}.`
          : res.error ?? "Sync failed.",
      );
      router.refresh();
    });
  }

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
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="green">Connected</Badge>
            {lastSyncedAt && (
              <span className="text-xs text-slate-400">
                Last synced {new Date(lastSyncedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </span>
            )}
            <Button size="sm" onClick={syncNow} disabled={pending}>
              <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
              Sync now
            </Button>
            <Button size="sm" variant="outline" onClick={sync} disabled={pending}>
              Push Schedule to Google
            </Button>
            <Button size="sm" variant="outline" onClick={disconnect} disabled={pending}>
              Disconnect
            </Button>
          </div>

          {/* Two-way: pick which Google calendars mirror INTO the schedule
              (read-only gray pills). CN jobs/appointments always push OUT. */}
          <div className="rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={togglePicker}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <span>
                Calendars shown on your schedule
                <span className="ml-2 text-xs font-normal text-slate-400">
                  {chosen.length ? `${chosen.length} selected` : "none"}
                </span>
              </span>
              {pickerOpen ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
            </button>
            {pickerOpen && (
              <div className="border-t border-slate-100 p-3">
                {!options ? (
                  <p className="text-sm text-slate-400">Loading your calendars…</p>
                ) : (
                  <>
                    <ul className="space-y-1.5">
                      {options.map((c) => (
                        <li key={c.id}>
                          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                            <input
                              type="checkbox"
                              checked={chosen.includes(c.id)}
                              onChange={() => toggleCalendar(c.id)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="min-w-0 truncate">
                              {c.summary}
                              {c.primary && <span className="ml-1 text-xs text-slate-400">(primary)</span>}
                            </span>
                          </label>
                        </li>
                      ))}
                      {!options.length && <li className="text-sm text-slate-400">No calendars found.</li>}
                    </ul>
                    <div className="mt-3 flex items-center gap-2">
                      <Button size="sm" onClick={savePicker} disabled={pending}>
                        Save calendars
                      </Button>
                      <span className="text-xs text-slate-400">
                        Their events show read-only on the schedule; syncs every 15 minutes.
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Jobs and appointments push to Google automatically as they change. Events created in
            Google stay Google-owned — CN shows them but never edits them.
          </p>
        </>
      ) : (
        <div>
          <a
            href="/api/google/connect"
            className="inline-flex items-center gap-2 rounded-lg bg-[rgb(var(--glass-ink))] px-4 py-2 text-sm font-medium text-white hover:bg-[rgb(var(--glass-ink))]/90"
          >
            <CalendarCheck className="h-4 w-4 shrink-0" /> Connect Google Calendar
          </a>
          <p className="mt-2 text-xs text-slate-400">
            Two-way: scheduled jobs and appointments push to your calendar as they change, and the
            Google calendars you pick show on the schedule read-only.
          </p>
        </div>
      )}
    </div>
  );
}
