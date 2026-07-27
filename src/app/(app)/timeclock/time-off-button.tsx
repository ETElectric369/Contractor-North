"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { setCrewOffRange, clearCrewOffRange } from "./crew-actions";

/**
 * TIME OFF — one action for a whole stretch.
 *
 * "Brian is on vacation right now until Aug 7 and I'm not sure if we've set up a way to handle
 * that easily." We hadn't. The only thing the app offered was to take him off jobs one at a time,
 * which is the wrong shape twice over: it's eleven edits for one fact, and it destroys the roster
 * so somebody has to put him back on every job, from memory, when he returns.
 *
 * A man out until the 7th is ONE fact about a PERSON. So it's one form: who, from, to, why. It
 * writes a day row per working day — the same OFF rows the board and the punch already respect
 * (0170) — and `jobs.assigned_to` is never touched, because he hasn't left the crew.
 */
export function TimeOffButton({
  members,
  defaultProfileId,
}: {
  members: { id: string; full_name: string | null }[];
  defaultProfileId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [profileId, setProfileId] = useState(defaultProfileId ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState<"vacation" | "sick" | "other">("vacation");
  const [weekends, setWeekends] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setErr(null);
      setMsg(null);
      const res = await setCrewOffRange({ profileId, fromDate: from, toDate: to, reason, includeWeekends: weekends });
      if (!res.ok) return setErr(res.error ?? "Couldn't save that.");
      const who = members.find((m) => m.id === profileId)?.full_name ?? "They";
      setMsg(`${who} is off for ${res.days} day${res.days === 1 ? "" : "s"}.`);
      router.refresh();
    });

  const undo = () =>
    start(async () => {
      setErr(null);
      const res = await clearCrewOffRange({ profileId, fromDate: from, toDate: to });
      if (!res.ok) return setErr(res.error ?? "Couldn't clear that.");
      setMsg("Those days are open again.");
      router.refresh();
    });

  const ready = !!profileId && !!from && !!to && to >= from;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CalendarOff className="h-4 w-4" /> Time off
      </Button>
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          title="Time off"
          size="md"
          footer={
            <ModalActions
              onCancel={() => setOpen(false)}
              onSave={save}
              saveLabel="Mark off"
              saving={pending}
              disabled={!ready}
            />
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              Marks these days off on the crew board. They stay on their jobs&rsquo; crews — this only says
              they&rsquo;re not there — and their Clock In won&rsquo;t land on a job by mistake.
            </p>
            <div>
              <Label htmlFor="to-who">Who</Label>
              <Select id="to-who" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                <option value="">Pick someone…</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name ?? "Crew member"}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="to-from">First day</Label>
                <Input id="to-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="to-to">Last day</Label>
                <Input id="to-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="to-why">Reason</Label>
                <Select id="to-why" value={reason} onChange={(e) => setReason(e.target.value as never)}>
                  <option value="vacation">Vacation</option>
                  <option value="sick">Sick</option>
                  <option value="other">Other</option>
                </Select>
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm text-slate-600">
                <input type="checkbox" className="h-4 w-4" checked={weekends} onChange={(e) => setWeekends(e.target.checked)} />
                {/* Weekdays only by default — a Saturday nobody was working doesn't need a record
                    saying so, and rows that say nothing bury the ones that do. */}
                Include weekends
              </label>
            </div>
            {msg && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                <span>{msg}</span>
                <button onClick={undo} disabled={pending} className="shrink-0 underline underline-offset-2">
                  Undo
                </button>
              </div>
            )}
            {err && <p className="text-sm text-red-600">{err}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
