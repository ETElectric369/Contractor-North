"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  Play,
  Square,
  MapPin,
  Mic,
  MicOff,
  Coffee,
  Loader2,
  Plus,
  Trash2,
  Briefcase,
  ArrowLeftRight,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { hoursBetween, formatDuration, formatFullAddress } from "@/lib/utils";
import { autoLunchMinutes } from "@/lib/lunch-rule";
import { jobLabel, jobSiteLabel } from "@/lib/schedule-options";
import { translator } from "@/lib/i18n";
import { drivingDistanceMiles } from "@/lib/google-maps";
import { getPosition } from "@/lib/geo";
import type { GeoPoint, JobCode, TimeEntry } from "@/lib/types";
import { useToast } from "@/components/toast";
import { clockIn, clockOut, switchJob, saveEntryNotes } from "./actions";
import { ClockStartPicker } from "./clock-start-picker";
import { DailyReportDebrief } from "./daily-report-debrief";

interface AllocRow {
  job_id: string;
  job_code: string;
  hours: number;
  minutes: number;
  description: string;
}

// A switch-recorded split segment already on the OPEN entry (server-written by
// switchJob), passed in so a page reload re-seeds the breakdown instead of
// losing the split at clock-out (which REPLACES the entry's allocations).
interface OpenAlloc {
  job_id: string | null;
  job_code: string | null;
  hours: number;
  description: string | null;
}

interface JobOption {
  id: string;
  job_number: string;
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  customer_name?: string | null; // feeds the codes-off customer · address label
  codes?: string[]; // this job's template codes (undefined = all org codes)
}

// Route through the shared geo helper (one option set, real secure-context/permission handling) instead
// of a third hand-rolled getCurrentPosition. Still returns null on failure — but the caller now SHOWS
// that the punch wasn't GPS-stamped instead of silently stamping gps:null.
//
// The punch tap is also the app's legitimate FIRST-GRANT moment for location (THE iOS RULE in geo.ts):
// doClockIn/doClockOut call this synchronously in their tap's transition, so getCurrentPosition fires
// inside the gesture — the one shape iOS honors with a real permission popup — and a successful fix
// memoizes the grant (geo:granted) inside geo.ts, which weather + the geofence monitor then read
// silently forever after. Don't add awaits ahead of this call.
//
// `capMs` caps how long the PUNCH waits on GPS. The clock-in punch passes a short cap so the field crew
// isn't held hostage by an 8s highAccuracy fix on bad reception (the other two clock-in surfaces punch
// instantly with no GPS at all) — if the fix lands inside the window it's stamped, otherwise we punch
// now and warn that the punch isn't location-stamped. Clock-out caps too (3s) — the button used to sit
// disabled and silent for the full 8s fix.
async function getGps(capMs?: number): Promise<GeoPoint | null> {
  const fix = getPosition({ enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }).then((r) =>
    r.status === "ok" ? { lat: r.coords.lat, lng: r.coords.lng, accuracy: r.accuracy } : null,
  );
  if (!capMs) return fix;
  // Race the real fix against a short cap; whichever resolves first wins (null = punch now, no GPS).
  return Promise.race([fix, new Promise<GeoPoint | null>((res) => setTimeout(() => res(null), capMs))]);
}

// Shown when a punch can't reach the server — the form state is kept, so nothing is
// lost; the tech taps again with signal (the await used to throw straight to the
// error boundary and eat the whole form).
const OFFLINE_MSG = "No connection — your entry is kept, try again when you have bars.";

// Split fractional hours into the h/m boxes (carrying a rounded-up 60m into the hour).
function toHM(hours: number): { hours: number; minutes: number } {
  const h = Math.max(0, Math.floor(hours));
  const m = Math.max(0, Math.round((hours - h) * 60));
  return m === 60 ? { hours: h + 1, minutes: 0 } : { hours: h, minutes: m };
}

export function TimeclockPanel({
  openEntry,
  openAllocations = [],
  jobCodes,
  jobs,
  lang,
  homeAddress = "",
  isStaff = true,
  crewLead = false,
  jobCodesEnabled = true,
}: {
  openEntry: TimeEntry | null;
  openAllocations?: OpenAlloc[];
  jobCodes: JobCode[];
  jobs: JobOption[];
  lang?: string;
  homeAddress?: string;
  isStaff?: boolean;
  /** Crew leads (any role) get the Nort end-of-day debrief after clocking out. */
  crewLead?: boolean;
  /** org setting timeclock_job_codes: false = no code pickers anywhere on the clock,
   *  and job labels lead with customer · street address. Default true = today's flow. */
  jobCodesEnabled?: boolean;
}) {
  const t = translator(lang);
  // The ONE label per mode (both from the schedule-options SSOT — never a local fork):
  // codes on = "J-0012 · Panel swap"; codes off = "Smith · 123 Main St".
  const optionLabel = (j: JobOption) => (jobCodesEnabled ? jobLabel(j) : jobSiteLabel(j));
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null); // "punch wasn't GPS-stamped" — surfaced, not silent
  const [pending, start] = useTransition();
  // SIMPLE BY DEFAULT FOR EVERYONE (Erik, cn-v502): Clock Out is ONE tap for every role —
  // the server auto-deducts lunch and the job was resolved at clock-in. The day-breakdown
  // questionnaire (jobs/hours, lunch/breaks, mileage, notes) still exists IN FULL, but
  // only behind the staff "More options → Clock out with details…" door; this flag opens it.
  const [clockingOut, setClockingOut] = useState(false);
  // The ONE quiet staff disclosure ("More options") — collapsed by default on both the
  // clock-in view (job + code pickers) and the running view (Switch Job + the details
  // door). Techs never render it; their flow has no tools to disclose.
  const [showTools, setShowTools] = useState(false);
  // Crew-lead debrief — opens AFTER a successful clock-out (the entry is closed, so this
  // state must live here, above the openEntry branch, to survive the panel's re-render).
  const [debriefOpen, setDebriefOpen] = useState(false);

  // clock-in form
  const [jobId, setJobId] = useState("");
  const [jobCode, setJobCode] = useState("");
  const [startAt, setStartAt] = useState(""); // "" = now; otherwise a chosen ISO

  // clock-out form
  const [notes, setNotes] = useState(openEntry?.notes ?? "");
  // Last notes value the server has — the debounced mid-shift autosave only fires
  // when the textarea actually moved past this.
  const lastSavedNotes = useRef(openEntry?.notes ?? "");
  const [allocations, setAllocations] = useState<AllocRow[]>([]);
  // True once the tech touches the breakdown — the live auto-ticking row stops,
  // and the amber "doesn't add up" warning becomes meaningful.
  const [allocsDirty, setAllocsDirty] = useState(false);
  // When the CURRENT job segment started: clock-in, or the last mid-shift switch.
  const [segmentStartIso, setSegmentStartIso] = useState<string | null>(null);
  const [miles, setMiles] = useState(0);
  const [calcingMiles, setCalcingMiles] = useState(false);

  // mid-shift job switch — its own transition so the clock-out button doesn't
  // flip to "Clocking out…" while a switch is in flight
  const [switching, setSwitching] = useState(false);
  const [switchJobId, setSwitchJobId] = useState("");
  const [switchJobCode, setSwitchJobCode] = useState("");
  const [switchPending, startSwitch] = useTransition();

  function addAlloc() {
    setAllocsDirty(true);
    setAllocations((p) => [
      ...p,
      { job_id: "", job_code: "", hours: 0, minutes: 0, description: "" },
    ]);
  }
  function updateAlloc(i: number, patch: Partial<AllocRow>) {
    setAllocsDirty(true);
    setAllocations((p) => p.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function removeAlloc(i: number) {
    setAllocsDirty(true);
    setAllocations((p) => p.filter((_, idx) => idx !== i));
  }
  const allocatedHours = allocations.reduce(
    (s, a) => s + (a.hours || 0) + (a.minutes || 0) / 60,
    0,
  );
  // (The old mandatory-allocation gate lived here — removed with the v497 two-button
  // tech flow: only STAFF reach this questionnaire now, and staff were never gated.)

  // Narrow the code picker to a job's template codes (so people pick the right code for
  // the job type). No template / unknown job → all org codes.
  function codesForJob(jobIdSel: string): JobCode[] {
    const j = jobs.find((x) => x.id === jobIdSel);
    if (j?.codes && j.codes.length) return jobCodes.filter((c) => j.codes!.includes(c.code));
    return jobCodes;
  }

  // live elapsed timer
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!openEntry) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [openEntry]);
  // Time text (elapsed timer + local clock-in time) is derived from the client's clock/timezone,
  // so it CANNOT match the server-rendered HTML — that mismatch was throwing React #418 on clocked-in
  // techs, which bails hydration and breaks interactivity (the "back button doesn't work" report).
  // Gate the timezone-local clock-in time until mounted; the ticking totals use suppressHydrationWarning.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Pre-seed the "jobs worked today" breakdown so the everyday case (one code all
  // day) is a single confirm. Segments already recorded by mid-shift switches seed
  // first (so the clock-out REPLACE round-trips them), then one LIVE row for the
  // current job — kept ticking by the effect below until the tech edits the split.
  // Seeds once per open entry (a ref keeps a cleared row from re-appearing).
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openEntry) {
      seededRef.current = null;
      return;
    }
    if (seededRef.current === openEntry.id) return;
    seededRef.current = openEntry.id;
    const prior = (openAllocations ?? []).map((a) => ({
      job_id: a.job_id ?? "",
      job_code: a.job_code ?? "",
      ...toHM(Number(a.hours) || 0),
      description: a.description ?? "",
    }));
    // The live segment starts where the recorded switches left off (clock-in + the
    // hours already allocated) — mirrors how switchJob derives it server-side.
    const priorHours = (openAllocations ?? []).reduce((s, a) => s + (Number(a.hours) || 0), 0);
    const segStart = new Date(new Date(openEntry.clock_in).getTime() + priorHours * 3_600_000).toISOString();
    setSegmentStartIso(segStart);
    setAllocsDirty(false);
    const seg = hoursBetween(segStart, new Date(), 0); // gross at open
    setAllocations([
      ...prior,
      { job_id: openEntry.job_id ?? "", job_code: openEntry.job_code ?? "", ...toHM(seg), description: "" },
    ]);
  }, [openEntry, openAllocations]);

  // voice dictation (Web Speech API — Chrome/Safari)
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);
  const speechSupported =
    typeof window !== "undefined" &&
    (("webkitSpeechRecognition" in window) || ("SpeechRecognition" in window));

  function toggleDictation() {
    if (listening) {
      recogRef.current?.stop();
      setListening(false);
      return;
    }
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = "en-US"; // talk + transcribe; translation can post-process server-side
    r.onresult = (e: any) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
      }
      setNotes((prev) => (prev ? prev + " " : "") + text.trim());
    };
    r.onend = () => setListening(false);
    r.start();
    recogRef.current = r;
    setListening(true);
  }

  function doClockIn() {
    setError(null);
    setGpsNote(null);
    start(async () => {
      // PUNCH FIRST. Don't make the crew wait out an 8s highAccuracy fix to start their day —
      // give GPS a short window (2.5s) and punch regardless; if the fix lands in time it's
      // stamped, otherwise the entry is created now and we warn it isn't location-stamped.
      const gps = await getGps(2500);
      try {
        const res = await clockIn({
          job_id: jobId || null,
          job_code: jobCode || null,
          gps,
          clock_in_at: startAt || null,
        });
        if (!res.ok) setError(res.error ?? "Could not clock in.");
        else {
          setShowTools(false); // fresh punch → the running view's disclosure starts closed
          // GPS is optional, but don't pretend it was captured — if it's off/denied/slow, say the
          // punch isn't location-stamped (this used to fall through to gps:null silently). The note
          // now renders in the clocked-in view too, so the crew actually sees it post-punch.
          if (!gps) setGpsNote("Clocked in — location wasn't ready, so this punch isn't GPS-stamped.");
        }
      } catch {
        // Dead spot / airplane mode — don't throw to the error boundary; the form
        // is intact, so the punch just needs another tap when there's signal.
        setError(OFFLINE_MSG);
      }
    });
  }

  // Lunch is AUTOMATIC (Erik 2026-07-22: no more took-a-lunch/breaks checkboxes) — the
  // ONE rule (>5 gross hrs ⇒ 30 min unpaid) drives the live display here; the server
  // applies the same rule at the punch, so the numbers match.
  const grossElapsed = openEntry ? hoursBetween(openEntry.clock_in, new Date(now), 0) : 0;
  const lunchToUse = autoLunchMinutes(grossElapsed);

  // The everyday-case row used to be computed ONCE (at mount) and go stale — by
  // clock-out time the numbers didn't match the shift and the row rendered a
  // scary amber mismatch. Keep the CURRENT segment's row live (net of lunch)
  // until the tech actually edits the breakdown; amber is then reserved for
  // genuinely user-edited mismatches. Bails on identical h/m so the every-second
  // tick doesn't churn state.
  useEffect(() => {
    if (!openEntry || allocsDirty) return;
    const seg = hoursBetween(segmentStartIso ?? openEntry.clock_in, new Date(now), lunchToUse);
    const { hours, minutes } = toHM(seg);
    setAllocations((p) => {
      if (!p.length) return p;
      const last = p[p.length - 1];
      if (last.hours === hours && last.minutes === minutes) return p;
      return [...p.slice(0, -1), { ...last, hours, minutes }];
    });
  }, [openEntry, allocsDirty, segmentStartIso, now, lunchToUse]);

  // Autosave the "what did you do today?" note mid-shift (debounced) — the
  // saveEntryNotes action existed but nothing called it, so a note typed during
  // the day only survived if the tech clocked out from this same screen session.
  useEffect(() => {
    if (!openEntry || notes === lastSavedNotes.current) return;
    const timer = setTimeout(() => {
      saveEntryNotes(openEntry.id, notes, null)
        .then((r) => {
          if (r.ok) lastSavedNotes.current = notes;
        })
        .catch(() => {}); // offline — keep typing; clock-out carries the note anyway
    }, 1200);
    return () => clearTimeout(timer);
  }, [notes, openEntry]);

  // Round-trip miles from the tech's home to the job being closed — the everyday
  // clock-out never captured mileage before (only manual entries did), so it was
  // missing on most timecards.
  function jobAddressForMiles(): string {
    const id = allocations.find((a) => a.job_id)?.job_id || openEntry?.job_id || "";
    const j = jobs.find((x) => x.id === id);
    return j ? formatFullAddress(j.address, j.city, j.state, j.zip) : "";
  }
  function autoMiles() {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    const jobAddr = jobAddressForMiles();
    if (!key || !homeAddress || !jobAddr) return;
    setCalcingMiles(true);
    drivingDistanceMiles(key, homeAddress, jobAddr)
      .then((oneWay) => {
        if (oneWay != null) setMiles(Math.round(oneWay * 2 * 10) / 10); // round trip
      })
      .finally(() => setCalcingMiles(false));
  }

  // Mid-shift job switch: the server records the outgoing job's hours as an
  // allocation + re-points the entry (and appends a notes breadcrumb); we mirror
  // that split locally so the clock-out REPLACE doesn't wipe it.
  function doSwitchJob() {
    if (!openEntry || !switchJobId) return;
    setError(null);
    startSwitch(async () => {
      try {
        // Same short cap as the punch: give GPS 2.5s and switch regardless. The fix
        // becomes the entry's NEW geofence anchor — leaving the old job's centre armed
        // is what let the fence auto-close the shift at the time they drove away from
        // the FIRST site. No fix ⇒ the server clears the anchor (it never keeps a stale
        // one) and the monitor re-adopts once there's a good fix at the new site.
        const gps = await getGps(2500);
        const res = await switchJob({
          entry_id: openEntry.id,
          job_id: switchJobId,
          job_code: switchJobCode || null,
          notes,
          gps,
        });
        if (!res.ok) {
          setError(res.error ?? "Could not switch jobs.");
          return;
        }
        const done: AllocRow = {
          job_id: openEntry.job_id ?? "",
          job_code: openEntry.job_code ?? "",
          ...toHM(res.segment_hours ?? 0),
          description: "before switching jobs",
        };
        const live: AllocRow = { job_id: switchJobId, job_code: switchJobCode, hours: 0, minutes: 0, description: "" };
        // Untouched: the last row IS the outgoing job's live row — swap it for the
        // finished segment + a fresh live row. Edited: only add the fresh row (the
        // tech owns the numbers now; the notes breadcrumb keeps the ground truth).
        setAllocations((p) => (allocsDirty ? [...p, live] : [...p.slice(0, -1), done, live]));
        setSegmentStartIso(new Date().toISOString());
        // The server appended the breadcrumb to the notes — sync the textarea so a
        // later notes save can't clobber it.
        if (res.notes != null) {
          lastSavedNotes.current = res.notes;
          setNotes(res.notes);
        }
        setSwitching(false);
        setSwitchJobId("");
        setSwitchJobCode("");
        const j = jobs.find((x) => x.id === switchJobId);
        toast(`Switched to ${j ? optionLabel(j) : "the new job"}`, "success");
      } catch {
        setError(OFFLINE_MSG);
      }
    });
  }

  // ONE clock-out for both doors — the one-tap button AND the details questionnaire
  // send the identical payload: lunch is null ("wasn't asked") and the server's
  // auto-lunch (>5h ⇒ 30 min) is the single source of truth; the questionnaire no
  // longer has a lunch answer to give (Erik 2026-07-22 — corrections live on
  // Timecards). Either way the seeded allocation rows ride along, so a mid-shift
  // switchJob split round-trips.
  function doClockOut() {
    if (!openEntry) return;
    setError(null);
    start(async () => {
      // Same short GPS cap as clock-in — the button used to sit disabled and
      // silent for up to the full 8s highAccuracy round-trip.
      const gps = await getGps(3000);
      // The lunch the server will deduct — the same auto rule clockOut applies to every
      // punch (no questionnaire answer exists anymore) — so the live row below nets out
      // to the exact paid hours.
      const punchLunch = autoLunchMinutes(hoursBetween(openEntry.clock_in, new Date(), 0));
      // Recompute the live row's hours AT THE PUNCH (net of lunch, exact) — the
      // displayed h/m round to the minute, and the old mount-time seed went stale.
      let rows = allocations;
      if (!allocsDirty && rows.length) {
        const seg = hoursBetween(segmentStartIso ?? openEntry.clock_in, new Date(), punchLunch);
        rows = [...rows.slice(0, -1), { ...rows[rows.length - 1], hours: seg, minutes: 0 }];
      }
      // A plain one-tap punch (untouched seed, no mid-shift switch → exactly the one
      // live row) should NOT manufacture an allocation row: a single row whose job_id is
      // null used to be COSTED to the entry's job (laborCostForJob) yet never BILLED
      // (the importer skipped any entry that had allocations) — a silent unbilled shift.
      // Omitting allocations leaves the entry split-free, so cost and bill both read its
      // gross hours. A dirtied split or a mid-shift switch (>1 row) still rides along.
      const plainPunch = !allocsDirty && rows.length === 1;
      try {
        const res = await clockOut({
          entry_id: openEntry.id,
          // null = "wasn't asked" for BOTH doors — the server's auto-lunch is the one
          // source of truth, immune to a client/server >5h race at the boundary.
          lunch_minutes: null,
          notes,
          gps,
          miles,
          allocations: plainPunch
            ? undefined
            : rows.map((a) => ({
                job_id: a.job_id || null,
                job_code: a.job_code || null,
                hours: (a.hours || 0) + (a.minutes || 0) / 60,
                description: a.description,
              })),
        });
        if (!res.ok) setError(res.error ?? "Could not clock out.");
        else {
          // Reset the view flags so the NEXT punch starts on the simple flow (leaving
          // clockingOut true used to reopen the questionnaire on a later clock-in).
          setClockingOut(false);
          setShowTools(false);
          setSwitching(false);
          // Crew leads owe the office the end-of-day debrief — Nort asks right here.
          if (crewLead) setDebriefOpen(true);
        }
      } catch {
        // Dead spot — the entry stays open and every field on this form is kept;
        // tapping again with signal completes the same clock-out.
        setError(OFFLINE_MSG);
      }
    });
  }

  // "Clock out now — break it down later." Defers the job/hours breakdown: passes auto:true so
  // the codes-and-hours requirement is skipped (the SAME escape the geofence auto-close uses), and
  // the entry lands with no allocations. /timeclock resurfaces it (the AutoClockoutPrompt) the next
  // time they open the page — which is every clock-in — so nothing bills to the wrong job silently.
  function doClockOutLater() {
    if (!openEntry) return;
    setError(null);
    start(async () => {
      const gps = await getGps(3000);
      try {
        const res = await clockOut({
          entry_id: openEntry.id,
          lunch_minutes: null, // server auto-lunch decides — same as every other punch
          notes,
          gps,
          miles,
          auto: true,
          allocations: [],
        });
        if (!res.ok) setError(res.error ?? "Could not clock out.");
        else {
          setClockingOut(false);
          setShowTools(false);
          setSwitching(false);
          if (crewLead) setDebriefOpen(true);
        }
      } catch {
        setError(OFFLINE_MSG);
      }
    });
  }

  // The Nort debrief lives OUTSIDE the openEntry branch: a successful clock-out
  // refreshes the page data and re-renders this panel into the not-clocked-in view,
  // and the modal must survive that swap.
  const debrief = crewLead ? (
    <DailyReportDebrief open={debriefOpen} onClose={() => setDebriefOpen(false)} />
  ) : null;

  if (openEntry) {
    const elapsed = hoursBetween(openEntry.clock_in, new Date(now), lunchToUse);
    // Codes on: name only (not the shared number·name jobLabel helper) — the running
    // banner reads better without the job number; renamed so the helper isn't shadowed.
    // Codes off: the customer · address identity IS the name the crew knows.
    const currentJob = jobs.find((j) => j.id === openEntry.job_id);
    const currentJobName = currentJob
      ? jobCodesEnabled
        ? currentJob.name
        : jobSiteLabel(currentJob)
      : "No job selected";
    return (
      <>
      <Card className="border-green-200">
        <CardContent className="space-y-5 py-6">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-green-500" />
            </span>
            <span className="text-sm font-medium text-green-700">
              {t("tc_clockedIn")} — {currentJobName}
              {openEntry.job_code ? ` · ${openEntry.job_code}` : ""}
            </span>
          </div>

          <div className="text-center">
            <div className="text-5xl font-bold tabular-nums tracking-tight text-slate-900" suppressHydrationWarning>
              {formatDuration(elapsed)}
            </div>
            <div className="mt-1 text-sm text-slate-400">
              {t("tc_since")} <span suppressHydrationWarning>{mounted ? new Date(openEntry.clock_in).toLocaleTimeString() : ""}</span>
              {openEntry.gps_in ? " · 📍" : ""}
            </div>
          </div>

          {/* Surface the "punch wasn't GPS-stamped" warning HERE — after a punch the panel
              re-renders into this clocked-in branch, so the note set on clock-in is now visible. */}
          {gpsNote && (
            <p className="flex items-center justify-center gap-1.5 text-center text-sm text-amber-600">
              <MapPin className="h-4 w-4 shrink-0" /> {gpsNote}
            </p>
          )}

          {/* The big Clock Out — ONE tap for EVERY role now (Erik, cn-v502: "simple by
              default for everyone"): no questionnaire, no lunch checkboxes, no mileage;
              the server auto-deducts lunch (>5h ⇒ 30 min) and any mid-shift split
              already recorded on the entry rides along via the seeded allocation rows.
              The full wrap-up still exists behind More options → "Clock out with details…". */}
          {!clockingOut && (
            <>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button
                variant="destructive"
                size="lg"
                className="w-full"
                onClick={() => doClockOut()}
                disabled={pending || switchPending}
              >
                {pending ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" /> {t("tc_clockingOut")}
                  </>
                ) : (
                  <>
                    <Square className="h-5 w-5" /> {t("tc_clockOut")}
                  </>
                )}
              </Button>

              {/* STAFF power tools, re-homed (nothing deleted) behind the ONE quiet
                  disclosure: the mid-shift Switch Job flow (captures the split AS IT
                  HAPPENS — outgoing hours recorded server-side + a notes breadcrumb)
                  and the door to the full clock-out questionnaire. A tech renders no
                  disclosure at all — their clock stays two buttons. */}
              {isStaff && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowTools((v) => !v)}
                    aria-expanded={showTools}
                    className="flex w-full items-center justify-center gap-1 py-1 text-xs font-medium text-slate-400 hover:text-slate-600"
                  >
                    More options
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showTools ? "rotate-180" : ""}`} />
                  </button>
                  {showTools && (
                    <div className="mt-1 space-y-3">
                      {switching ? (
                        <div className="space-y-2 rounded-xl border border-brand/30 bg-brand/5 p-3">
                          <Label className="mb-0 flex items-center gap-1.5 text-slate-900">
                            <ArrowLeftRight className="h-4 w-4 text-brand" /> Switch job
                          </Label>
                          <p className="text-xs text-slate-500">
                            Your time on {currentJobName} so far is recorded; the clock keeps running on the new job.
                          </p>
                          <Select
                            value={switchJobId}
                            onChange={(e) => {
                              setSwitchJobId(e.target.value);
                              setSwitchJobCode("");
                            }}
                            className="h-11 w-full"
                            aria-label="New job"
                          >
                            <option value="">— New job —</option>
                            {jobs
                              .filter((j) => j.id !== openEntry.job_id)
                              .map((j) => (
                                <option key={j.id} value={j.id}>
                                  {optionLabel(j)}
                                </option>
                              ))}
                          </Select>
                          {/* Codes off: the switch is just "which job now" — no code question;
                              the allocation the server records carries a null code. */}
                          {jobCodesEnabled && (
                            <Select
                              value={switchJobCode}
                              onChange={(e) => setSwitchJobCode(e.target.value)}
                              className="h-11 w-full"
                              aria-label="New job code"
                            >
                              <option value="">Code (optional)</option>
                              {codesForJob(switchJobId).map((c) => (
                                <option key={c.id} value={c.code}>
                                  {c.code}{c.description ? ` · ${c.description}` : ""}
                                </option>
                              ))}
                            </Select>
                          )}
                          <div className="flex gap-2">
                            <Button className="flex-1" onClick={doSwitchJob} disabled={switchPending || !switchJobId}>
                              {switchPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />} Switch
                            </Button>
                            <Button variant="outline" onClick={() => setSwitching(false)} disabled={switchPending}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button type="button" variant="outline" className="w-full" onClick={() => setSwitching(true)}>
                          <ArrowLeftRight className="h-4 w-4" /> Switch Job
                        </Button>
                      )}
                      {/* The EXISTING wrap-up questionnaire (lunch/breaks/split/miles/notes),
                          exactly as it was — just no longer the default path. */}
                      <button
                        type="button"
                        onClick={() => setClockingOut(true)}
                        className="w-full text-center text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
                      >
                        Clock out with details…
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* WRAPPING UP — the clock-out questionnaire: confirm breaks, break the day into jobs,
              mileage + notes, then clock out. Hidden until the Clock Out tap above. */}
          {clockingOut && (
            <>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-semibold text-slate-900">Wrapping up your day</p>
                <p className="mt-0.5 text-xs text-slate-500">You worked {formatDuration(elapsed)}. Break it down below, then clock out.</p>
              </div>

          {/* Lunch is automatic — the checkboxes are gone by design (Erik 2026-07-22).
              Say what will happen so the deduction is never a surprise. */}
          {lunchToUse > 0 && (
            <p className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              <Coffee className="h-4 w-4 shrink-0 text-slate-400" />
              Over 5 hours — a 30-minute unpaid lunch is deducted automatically.
            </p>
          )}

          {/* Jobs worked today — the PRIMARY clock-out question: which code(s) + hours.
              This is the wrong-hours-on-wrong-jobs fix; required for the field crew. */}
          <div className="rounded-xl border border-brand/30 bg-brand/5 p-3">
            <div className="mb-1 flex items-center justify-between">
              <Label className="mb-0 flex items-center gap-1.5 text-slate-900">
                <Briefcase className="h-4 w-4 text-brand" /> {t("tc_jobsToday")}
              </Label>
              <button
                type="button"
                onClick={addAlloc}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                <Plus className="h-4 w-4 shrink-0" /> {t("tc_addJob")}
              </button>
            </div>
            <p className="mb-2 text-xs text-slate-500">
              {jobCodesEnabled
                ? "Which job code(s) did you work today, and how many hours on each? Usually one — split it if you worked more than one."
                : "Which job(s) did you work today, and how many hours on each? Usually one — split it if you worked more than one."}
            </p>
            {allocations.length === 0 ? (
              <p className="text-xs text-slate-400">{t("tc_breakdownHint")}</p>
            ) : (
              <div className="space-y-2">
                {allocations.map((a, i) => (
                  <div key={i} className="space-y-2 rounded-lg border border-slate-100 p-2">
                    {/* Row 1: the job + remove. Job select takes the full width so the
                        long "number · name" label is readable on a phone. */}
                    <div className="flex items-center gap-2">
                      <Select
                        value={a.job_id}
                        onChange={(e) => updateAlloc(i, { job_id: e.target.value })}
                        className="h-11 min-w-0 flex-1"
                      >
                        <option value="">— Job —</option>
                        {jobs.map((j) => (
                          <option key={j.id} value={j.id}>
                            {optionLabel(j)}
                          </option>
                        ))}
                      </Select>
                      <button
                        type="button"
                        onClick={() => removeAlloc(i)}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"
                        aria-label="Remove job"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    {/* Row 2: code + hours/minutes. STACKS under the job on a narrow phone
                        (instead of cramming 5 controls into one 327px row, where a minute
                        got typed into the hours box). The h/m boxes are wider here too.
                        Codes off: no code question — the row is just the job + its hours. */}
                    <div className={jobCodesEnabled ? "flex items-center gap-2" : "flex items-center justify-end gap-2"}>
                      {jobCodesEnabled && (
                        <Select
                          value={a.job_code}
                          onChange={(e) => updateAlloc(i, { job_code: e.target.value })}
                          className="h-11 min-w-0 flex-1"
                        >
                          <option value="">Code</option>
                          {codesForJob(a.job_id).map((c) => (
                            <option key={c.id} value={c.code}>
                              {c.code}{c.description ? ` · ${c.description}` : ""}
                            </option>
                          ))}
                        </Select>
                      )}
                      <div className="flex shrink-0 items-center gap-1">
                        <NumberInput
                          value={a.hours}
                          onValueChange={(n) => updateAlloc(i, { hours: n })}
                          className="h-11 w-14 text-center"
                          placeholder="h"
                          aria-label="Hours"
                        />
                        <span className="text-xs text-slate-400">h</span>
                        <NumberInput
                          value={a.minutes}
                          onValueChange={(n) => updateAlloc(i, { minutes: n })}
                          className="h-11 w-14 text-center"
                          placeholder="m"
                          aria-label="Minutes"
                        />
                        <span className="text-xs text-slate-400">m</span>
                      </div>
                    </div>
                    <Input
                      placeholder={t("tc_whatDone")}
                      value={a.description}
                      onChange={(e) => updateAlloc(i, { description: e.target.value })}
                    />
                  </div>
                ))}
                {/* Amber only when the TECH's edits don't add up — the untouched live
                    row tracks the shift, so it can't drift into a false warning. */}
                <div className={`text-right text-xs ${allocsDirty && Math.abs(allocatedHours - elapsed) > 0.1 ? "text-amber-600" : "text-slate-500"}`} suppressHydrationWarning>
                  {t("tc_allocated")}: {formatDuration(allocatedHours)} of {formatDuration(elapsed)} worked
                </div>
              </div>
            )}
          </div>

          {/* Mileage — round-trip home → job, captured right on clock-out (it used
              to only exist on manual entries, so most timecards had none). Miles
              ONLY — no dollar preview: mileage pay is a human decision settled on
              /payroll, never an app-computed rate×miles promise to the tech. */}
          <div>
            <Label className="mb-1 flex items-center gap-1">
              <MapPin className="h-4 w-4 text-slate-400" /> Miles
            </Label>
            <div className="flex items-center gap-2">
              <NumberInput value={miles} onValueChange={setMiles} className="h-9 w-24" />
              <span className="text-xs text-slate-400">round trip</span>
              {!!(homeAddress && jobAddressForMiles() && process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) && (
                <Button type="button" size="sm" variant="outline" onClick={autoMiles} disabled={calcingMiles} title="Round trip: home ↔ job">
                  {calcingMiles ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />} Auto
                </Button>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0">{t("tc_whatToday")}</Label>
              {speechSupported && (
                <button
                  type="button"
                  onClick={toggleDictation}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${
                    listening
                      ? "bg-red-50 text-red-600"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {listening ? (
                    <>
                      <MicOff className="h-4 w-4 shrink-0" /> {t("tc_stop")}
                    </>
                  ) : (
                    <>
                      <Mic className="h-4 w-4 shrink-0" /> {t("tc_dictate")}
                    </>
                  )}
                </button>
              )}
            </div>
            <Textarea
              rows={3}
              placeholder={t("tc_summarize")}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <div className="flex gap-2">
                <Button variant="outline" size="lg" onClick={() => setClockingOut(false)} disabled={pending}>
                  Back
                </Button>
                <Button
                  variant="destructive"
                  size="lg"
                  className="flex-1"
                  onClick={() => doClockOut()}
                  disabled={pending}
                >
                  {pending ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" /> {t("tc_clockingOut")}
                    </>
                  ) : (
                    <>
                      <Square className="h-5 w-5" /> Confirm &amp; clock out
                    </>
                  )}
                </Button>
              </div>

              {/* The escape hatch: clock out clean now, answer the breakdown later. It lands as an
                  incomplete entry that /timeclock re-prompts on your next visit — so a busy crew
                  never has to stand in the driveway filling in job codes. */}
              <button
                type="button"
                onClick={doClockOutLater}
                disabled={pending}
                className="w-full pt-1 text-center text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline disabled:opacity-50"
              >
                Clock out now — I&apos;ll break it down later
              </button>
            </>
          )}
        </CardContent>
      </Card>
      {debrief}
      </>
    );
  }

  // Not clocked in
  return (
    <>
    <Card>
      <CardContent className="space-y-5 py-6">
        <div className="text-center">
          <p className="text-sm text-slate-500">{t("tc_notClockedIn")}</p>
        </div>

        <div>
          <Label>Start time</Label>
          <ClockStartPicker onChange={(iso) => setStartAt(iso ?? "")} staff={isStaff} />
        </div>

        {/* Job + code pickers — STAFF only, and tucked behind the ONE quiet "More
            options" disclosure now (Erik, cn-v502: "simple by default for EVERYONE").
            The default punch is job-less; the server resolves the job — today's
            assignment, else the org's only in-progress job, else none (the office
            attaches it later). Techs render no disclosure at all. */}
        {isStaff && (
          <div>
            <button
              type="button"
              onClick={() => setShowTools((v) => !v)}
              aria-expanded={showTools}
              className="flex w-full items-center justify-center gap-1 py-1 text-xs font-medium text-slate-400 hover:text-slate-600"
            >
              More options
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showTools ? "rotate-180" : ""}`} />
            </button>
            {showTools && (
              <div className="mt-2 grid gap-4 sm:grid-cols-2">
                {/* Codes off: the job picker spans the row and the code question is gone. */}
                <div className={jobCodesEnabled ? "" : "sm:col-span-2"}>
                  <Label htmlFor="job">{t("tc_job")}</Label>
                  <Select id="job" value={jobId} onChange={(e) => setJobId(e.target.value)} className="h-11">
                    <option value="">{t("tc_noJob")}</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {optionLabel(j)}
                      </option>
                    ))}
                  </Select>
                </div>
                {jobCodesEnabled && (
                  <div>
                    <Label htmlFor="code">{t("tc_jobCode")}</Label>
                    <Select id="code" value={jobCode} onChange={(e) => setJobCode(e.target.value)} className="h-11">
                      <option value="">{t("tc_selectCode")}</option>
                      {codesForJob(jobId).map((c) => (
                        <option key={c.id} value={c.code}>
                          {c.code} — {c.description}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        {gpsNote && <p className="text-sm text-amber-600">{gpsNote}</p>}

        <Button size="lg" className="w-full" onClick={doClockIn} disabled={pending}>
          {pending ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" /> {t("tc_clockingIn")}
            </>
          ) : (
            <>
              <Play className="h-5 w-5" /> {t("tc_clockIn")}
            </>
          )}
        </Button>
        <p className="flex items-center justify-center gap-1.5 text-xs text-slate-400">
          <MapPin className="h-3.5 w-3.5" /> {t("tc_locationNote")}
        </p>
      </CardContent>
    </Card>
    {debrief}
    </>
  );
}
