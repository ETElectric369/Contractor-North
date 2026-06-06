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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { hoursBetween, formatDuration } from "@/lib/utils";
import type { GeoPoint, JobCode, TimeEntry } from "@/lib/types";
import { clockIn, clockOut } from "./actions";

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
}: {
  openEntry: TimeEntry | null;
  jobCodes: JobCode[];
  jobs: JobOption[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // clock-in form
  const [jobId, setJobId] = useState("");
  const [jobCode, setJobCode] = useState("");

  // clock-out form
  const [lunch, setLunch] = useState(0);
  const [notes, setNotes] = useState(openEntry?.notes ?? "");

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
              Clocked in — {jobLabel}
              {openEntry.job_code ? ` · ${openEntry.job_code}` : ""}
            </span>
          </div>

          <div className="text-center">
            <div className="text-5xl font-bold tabular-nums tracking-tight text-slate-900">
              {formatDuration(elapsed)}
            </div>
            <div className="mt-1 text-sm text-slate-400">
              Since {new Date(openEntry.clock_in).toLocaleTimeString()}
              {openEntry.gps_in ? " · 📍 location captured" : ""}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="lunch" className="flex items-center gap-1.5">
                <Coffee className="h-4 w-4 text-slate-400" /> Lunch (minutes)
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

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0">What did you do today?</Label>
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
                      <MicOff className="h-3.5 w-3.5" /> Stop
                    </>
                  ) : (
                    <>
                      <Mic className="h-3.5 w-3.5" /> Dictate
                    </>
                  )}
                </button>
              )}
            </div>
            <Textarea
              rows={3}
              placeholder="Summarize the work performed…"
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
                <Loader2 className="h-5 w-5 animate-spin" /> Clocking out…
              </>
            ) : (
              <>
                <Square className="h-5 w-5" /> Clock out
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
          <p className="text-sm text-slate-500">You're not clocked in.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="job">Job (optional)</Label>
            <Select id="job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">— No job —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.job_number} · {j.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="code">Job code</Label>
            <Select id="code" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
              <option value="">— Select code —</option>
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
              <Loader2 className="h-5 w-5 animate-spin" /> Clocking in…
            </>
          ) : (
            <>
              <Play className="h-5 w-5" /> Clock in
            </>
          )}
        </Button>
        <p className="flex items-center justify-center gap-1.5 text-xs text-slate-400">
          <MapPin className="h-3.5 w-3.5" /> Your location is captured at clock
          in/out for job verification.
        </p>
      </CardContent>
    </Card>
  );
}
