"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { DayField } from "@/components/day-field";
import { Modal, ModalActions } from "@/components/ui/modal";
import { setCrewOffRange, clearCrewOffRange } from "../timeclock/crew-actions";
import { useLang } from "@/components/lang-provider";
import { translator, fillText } from "@/lib/i18n";

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
 *
 * IT LIVES BESIDE EVERYONE'S DAY NOW (cn-v951). It used to sit in the /timeclock crew box that
 * Erik reported dead ("we have this time off box that was showing the scheduled jobs too but then
 * stopped and now its just in the way and doesnt show anything so we still need the
 * functionality"). The grid that box wrapped is gone; this was the one piece of it with nowhere
 * else to live, so it moved to the board that DRAWS the rows it writes — a range here, a single
 * day by tapping the person's lane. Behaviour is unchanged.
 */
export function TimeOffButton({
  members,
  defaultProfileId,
}: {
  members: { id: string; full_name: string | null }[];
  defaultProfileId?: string;
}) {
  const router = useRouter();
  const t = translator(useLang());
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
      if (!res.ok) return setErr(res.error ?? t("ag_rail_couldntSave"));
      const who = members.find((m) => m.id === profileId)?.full_name ?? t("ag_rail_they");
      setMsg(fillText(t(res.days === 1 ? "ag_rail_offForOne" : "ag_rail_offForMany"), { who, n: String(res.days) }));
      router.refresh();
    });

  const undo = () =>
    start(async () => {
      setErr(null);
      const res = await clearCrewOffRange({ profileId, fromDate: from, toDate: to });
      if (!res.ok) return setErr(res.error ?? t("ag_rail_couldntClear"));
      setMsg(t("ag_rail_daysOpenAgain"));
      router.refresh();
    });

  const ready = !!profileId && !!from && !!to && to >= from;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CalendarOff className="h-4 w-4" /> {t("ag_rail_btn_timeOff")}
      </Button>
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          title={t("ag_rail_btn_timeOff")}
          size="md"
          footer={
            <ModalActions
              onCancel={() => setOpen(false)}
              onSave={save}
              saveLabel={t("ag_rail_btn_markOff")}
              saving={pending}
              disabled={!ready}
            />
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-500">{t("ag_rail_timeOffLead")}</p>
            {/* SAY WHAT IT DOES NOT DO. setJobCrew tells a person when they are put ON a job; nothing
                tells them when they are marked OFF, so this form was quietly deciding somebody is not
                working and letting him find out on his own. Until that notification exists, the form
                says so rather than letting the silence pass for an arrangement. */}
            <p className="text-sm font-medium text-amber-700">{t("ag_rail_notTold")}</p>
            <div>
              <Label htmlFor="to-who">{t("ag_rail_who")}</Label>
              <Select id="to-who" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                <option value="">{t("ag_rail_btn_pickSomeone")}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name ?? t("ag_rail_crewMember")}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="to-from">{t("ag_rail_firstDay")}</Label>
                <DayField id="to-from" value={from} onChange={(iso) => setFrom(iso)} />
              </div>
              <div>
                <Label htmlFor="to-to">{t("ag_rail_lastDay")}</Label>
                <DayField id="to-to" value={to} onChange={(iso) => setTo(iso)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="to-why">{t("ag_rail_reason")}</Label>
                <Select id="to-why" value={reason} onChange={(e) => setReason(e.target.value as never)}>
                  <option value="vacation">{t("ag_rail_vacation")}</option>
                  <option value="sick">{t("ag_rail_sick")}</option>
                  <option value="other">{t("ag_rail_otherReason")}</option>
                </Select>
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm text-slate-600">
                <input type="checkbox" className="h-4 w-4" checked={weekends} onChange={(e) => setWeekends(e.target.checked)} />
                {/* Weekdays only by default — a Saturday nobody was working doesn't need a record
                    saying so, and rows that say nothing bury the ones that do. */}
                {t("ag_rail_includeWeekends")}
              </label>
            </div>
            {msg && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                <span>{msg}</span>
                <button onClick={undo} disabled={pending} className="shrink-0 underline underline-offset-2">
                  {t("ag_btn_undo")}
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
