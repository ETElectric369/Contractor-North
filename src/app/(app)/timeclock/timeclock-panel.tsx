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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { hoursBetween, formatDuration } from "@/lib/utils";
import { translator } from "@/lib/i18n";
import type { GeoPoint, JobCode, TimeEntry } from "@/lib/types";
import { clockIn, clockOut } from "./actions";

interface AllocRow {
  job_id: string;
  job_code: string;
  hours: number;
  minutes: number;
  description: string;
}

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}

function getGps(): Promise<GeoPoint | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}

export function TimeclockPanel({
  openEntry,
  jobCodes,
  jobs,
  lang,
}: {
  openEntry: TimeEntry | null;
  jobCodes: JobCode[];
  jobs: JobOption[];
  lang?: string;
}) {
  const t = translator(lang);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // clock-in form
  const [jobId, setJobId] = useState("");
  const [jobCode, setJobCode] = useState("");

  // clock-out form
  const [lunch, setLunch] = useState(0);
  const [notes, setNotes] = useState(openEntry?.notes ?? "");
  const [allocations, setAllocations] = useState<AllocRow[]>([]);

  function addAlloc() {
    setAllocations((p) => [
      ...p,
      { job_id: "", job_code: "", hours: 0, minutes: 0, description: "" },
    ]);
  }
  function updateAlloc(i: number, patch: Partial<AllocRow>) {
    setAllocations((p) => p.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  const allocatedHours = allocations.reduce(
    (s, a) => s + (a.hours || 0) + (a.minutes || 0) / 60,
    0,
  );

  // live elapsed timer
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!openEntry) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [openEntry]);

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
    start(async () => {
      const gps = await getGps();
      const res = await clockIn({
        job_id: jobId || null,
        job_code: jobCode || null,
        gps,
      });
      if (!res.ok) setError(res.error ?? "Could not clock in.");
    });
  }

  function doClockOut() {
    if (!openEntry) return;
    setError(null);
    start(async () => {
      const gps = await getGps();
      const res = await clockOut({
        entry_id: openEntry.id,
        lunch_minutes: lunch,
        notes,
        gps,
        allocations: allocations.map((a) => ({
          job_id: a.job_id || null,
          job_code: a.job_code || null,
          hours: (a.hours || 0) + (a.minutes || 0) / 60,
          description: a.description,
        })),
      });
      if (!res.ok) setError(res.error ?? "Could not clock out.");
    });
  }

  if (openEntry) {
    const elapsed = hoursBetween(openEntry.clock_in, new Date(now), lunch);
    const jobLabel =
      jobs.find((j) => j.id === openEntry.job_id)?.name ?? "No job selected";
    return (
      <Card className="border-green-200">
        <CardContent className="space-y-5 py-6">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-green-500" />
            </span>
            <span className="text-sm font-medium text-green-700">
              {t("tc_clockedIn")} — {jobLabel}
              {openEntry.job_code ? ` · ${openEntry.job_code}` : ""}
            </span>
          </div>

          <div className="text-center">
            <div className="text-5xl font-bold tabular-nums tracking-tight text-slate-900">
              {formatDuration(elapsed)}
            </div>
            <div className="mt-1 text-sm text-slate-400">
              {t("tc_since")} {new Date(openEntry.clock_in).toLocaleTimeString()}
              {openEntry.gps_in ? " · 📍" : ""}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="lunch" className="flex items-center gap-1.5">
                <Coffee className="h-4 w-4 text-slate-400" /> {t("tc_lunch")}
              </Label>
              <Input
                id="lunch"
                type="number"
                min={0}
                value={lunch}
                onChange={(e) => setLunch(Number(e.target.value) || 0)}
              />
            </div>
          </div>

          {/* Jobs worked today */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0 flex items-center gap-1.5">
                <Briefcase className="h-4 w-4 text-slate-400" /> {t("tc_jobsToday")}
              </Label>
              <button
                type="button"
                onClick={addAlloc}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
              >
                <Plus className="h-3.5 w-3.5" /> {t("tc_addJob")}
              </button>
            </div>
            {allocations.length === 0 ? (
              <p className="text-xs text-slate-400">{t("tc_breakdownHint")}</p>
            ) : (
              <div className="space-y-2">
                {allocations.map((a, i) => (
                  <div key={i} className="space-y-2 rounded-lg border border-slate-100 p-2">
                    <div className="flex items-center gap-2">
                      <Select
                        value={a.job_id}
                        onChange={(e) => updateAlloc(i, { job_id: e.target.value })}
                        className="h-9 flex-1"
                      >
                        <option value="">— Job —</option>
                        {jobs.map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.job_number} · {j.name}
                          </option>
                        ))}
                      </Select>
                      <Select
                        value={a.job_code}
                        onChange={(e) => updateAlloc(i, { job_code: e.target.value })}
                        className="h-9 w-28"
                      >
                        <option value="">Code</option>
                        {jobCodes.map((c) => (
                          <option key={c.id} value={c.code}>
                            {c.code}
                          </option>
                        ))}
                      </Select>
                      <div className="flex items-center gap-1">
                        <NumberInput
                          value={a.hours}
                          onValueChange={(n) => updateAlloc(i, { hours: n })}
                          className="h-9 w-12 text-center"
                          placeholder="h"
                        />
                        <span className="text-xs text-slate-400">h</span>
                        <NumberInput
                          value={a.minutes}
                          onValueChange={(n) => updateAlloc(i, { minutes: n })}
                          className="h-9 w-12 text-center"
                          placeholder="m"
                        />
                        <span className="text-xs text-slate-400">m</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAllocations((p) => p.filter((_, idx) => idx !== i))}
                        className="text-slate-400 hover:text-red-600"
                        aria-label="Remove job"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <Input
                      placeholder={t("tc_whatDone")}
                      value={a.description}
                      onChange={(e) => updateAlloc(i, { description: e.target.value })}
                    />
                  </div>
                ))}
                <div className="text-right text-xs text-slate-500">
                  {t("tc_allocated")}: {formatDuration(allocatedHours)}
                </div>
              </div>
            )}
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
                      <MicOff className="h-3.5 w-3.5" /> {t("tc_stop")}
                    </>
                  ) : (
                    <>
                      <Mic className="h-3.5 w-3.5" /> {t("tc_dictate")}
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

          <Button
            variant="destructive"
            size="lg"
            className="w-full"
            onClick={doClockOut}
            disabled={pending}
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
        </CardContent>
      </Card>
    );
  }

  // Not clocked in
  return (
    <Card>
      <CardContent className="space-y-5 py-6">
        <div className="text-center">
          <p className="text-sm text-slate-500">{t("tc_notClockedIn")}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="job">{t("tc_job")}</Label>
            <Select id="job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">{t("tc_noJob")}</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.job_number} · {j.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="code">{t("tc_jobCode")}</Label>
            <Select id="code" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
              <option value="">{t("tc_selectCode")}</option>
              {jobCodes.map((c) => (
                <option key={c.id} value={c.code}>
                  {c.code} — {c.description}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

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
  );
}
