"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, ChevronRight, ChevronLeft, Ruler, ClipboardList, Home, User } from "lucide-react";
import { computeDeckEstimate, type DeckAnswers, type DeckMaterial, type DeckShape } from "@/lib/estimate/deck";
import { classifyLead, PROJECT_TYPES, type LeadIntake, type ProjectType } from "@/lib/lead-triage";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { submitEstimateLead } from "./actions";
import type { EstimateResult, Qualifying } from "./types";

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

// Height at the tallest point → a representative height (ft) for the band adder.
const HEIGHT_BANDS: { value: string; label: string; ft: number }[] = [
  { value: "ground", label: "On the ground / low", ft: 2 },
  { value: "under10", label: "Up to 10 ft", ft: 8 },
  { value: "10_20", label: "10–20 ft", ft: 15 },
  { value: "20_30", label: "20–30 ft", ft: 25 },
  { value: "over30", label: "Over 30 ft", ft: 35 },
];

type Form = {
  projectType: ProjectType;
  plans: "yes" | "no" | "";
  approved: "yes" | "no" | "unsure" | "";
  noPlansPath: "sketch" | "dimensions" | "design_help" | "";
  lengthFt: number;
  widthFt: number;
  heightBand: string;
  material: DeckMaterial;
  shape: DeckShape;
  wrapAround: boolean;
  stairFlights: number;
  stairRailingLf: number;
  manDoors: number;
  sliderDoors: number;
  trpa: boolean;
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  hp: string;
};

const STEPS = [
  { icon: ClipboardList, label: "Project" },
  { icon: Ruler, label: "Size" },
  { icon: Home, label: "Details" },
  { icon: User, label: "Contact" },
];

export function Configurator({
  handle, orgName, brand, rates, threshold, headline, tagline,
}: {
  handle: string; orgName: string; brand: string; rates: Record<string, number>;
  threshold: number; headline: string; tagline: string;
}) {
  const [f, setF] = useState<Form>({
    projectType: "new_deck", plans: "", approved: "", noPlansPath: "",
    lengthFt: 0, widthFt: 0, heightBand: "under10", material: "wood", shape: "rectangle", wrapAround: false,
    stairFlights: 0, stairRailingLf: 0, manDoors: 0, sliderDoors: 0, trpa: false,
    name: "", phone: "", email: "", address: "", city: "", state: "", zip: "", hp: "",
  });
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EstimateResult | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const answers: DeckAnswers = useMemo(() => ({
    projectType: f.projectType,
    material: f.material,
    lengthFt: f.lengthFt,
    widthFt: f.widthFt,
    heightFt: HEIGHT_BANDS.find((b) => b.value === f.heightBand)?.ft ?? 8,
    railingLf: null,
    stairFlights: f.stairFlights,
    stairRailingLf: f.stairRailingLf,
    shape: f.shape,
    wrapAround: f.wrapAround,
    manDoors: f.manDoors,
    sliderDoors: f.sliderDoors,
    trpa: f.trpa,
  }), [f]);

  const qualifying: Qualifying = useMemo(() => ({
    hasPlans: f.plans === "yes",
    plansApproved: f.plans === "yes" ? (f.approved || null) as Qualifying["plansApproved"] : null,
    noPlansPath: f.plans === "no" ? (f.noPlansPath || null) as Qualifying["noPlansPath"] : null,
  }), [f.plans, f.approved, f.noPlansPath]);

  const est = useMemo(() => computeDeckEstimate(answers, (c) => rates[c] ?? 0), [answers, rates]);
  const preview = useMemo(() => {
    const intake: LeadIntake = {
      projectType: f.projectType,
      hasPlans: qualifying.hasPlans,
      plansApproved: qualifying.plansApproved,
      hasSketch: qualifying.noPlansPath === "sketch",
      hasDimensions: qualifying.noPlansPath === "dimensions" || (f.lengthFt > 0 && f.widthFt > 0),
      needsDesignHelp: qualifying.noPlansPath === "design_help" || f.projectType === "unsure",
      estimateTotal: est.total,
    };
    return classifyLead(intake, { inspectionThreshold: threshold });
  }, [f.projectType, f.lengthFt, f.widthFt, qualifying, est.total, threshold]);

  async function submit() {
    setError(null);
    if (!f.name.trim()) { setStep(3); return setError("Please enter your name."); }
    if (!f.phone.trim() && !f.email.trim()) { setStep(3); return setError("Add a phone or email so we can reach you."); }
    setBusy(true);
    try {
      const res = await submitEstimateLead(handle, { answers, qualifying, contact: {
        name: f.name, phone: f.phone, email: f.email, address: f.address, city: f.city, state: f.state, zip: f.zip,
      }, hp: f.hp });
      if (!res.ok) { setError(res.error ?? "Something went wrong."); return; }
      setResult(res);
    } catch {
      setError("Something went wrong — please call us instead.");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2";
  const ring = { ["--tw-ring-color" as string]: brand } as React.CSSProperties;

  if (result) return <ResultView result={result} orgName={orgName} brand={brand} est={est} />;

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 pb-24 pt-8" style={{ background: `linear-gradient(160deg, ${brand}14, transparent 60%)` }}>
      <header className="mb-6">
        <div className="inline-block rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white" style={{ backgroundColor: brand }}>
          {orgName}
        </div>
        <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">{headline}</h1>
        <p className="mt-1 text-slate-600">{tagline}</p>
      </header>

      {/* Progress */}
      <ol className="mb-6 flex items-center gap-2">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const active = i === step, done = i < step;
          return (
            <li key={s.label} className="flex flex-1 items-center gap-2">
              <button
                type="button"
                onClick={() => i < step && setStep(i)}
                className="flex items-center gap-2 text-sm font-medium disabled:cursor-default"
                disabled={i > step}
                style={{ color: active || done ? brand : "#94a3b8" }}
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full border-2" style={{ borderColor: active || done ? brand : "#e2e8f0", backgroundColor: done ? brand : "transparent" }}>
                  {done ? <CheckCircle2 className="h-4 w-4 text-white" /> : <Icon className="h-4 w-4" />}
                </span>
                <span className="hidden sm:inline">{s.label}</span>
              </button>
              {i < STEPS.length - 1 && <span className="h-0.5 flex-1 rounded" style={{ backgroundColor: i < step ? brand : "#e2e8f0" }} />}
            </li>
          );
        })}
      </ol>

      <div className="rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm backdrop-blur-sm sm:p-6">
        {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {step === 0 && (
          <div className="space-y-4">
            <L label="What kind of project?">
              <select className={field} style={ring} value={f.projectType} onChange={(e) => set("projectType", e.target.value as ProjectType)}>
                {PROJECT_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </L>
            <L label="Do you have engineered plans?">
              <Seg brand={brand} value={f.plans} onChange={(v) => set("plans", v as Form["plans"])} options={[{ v: "yes", l: "Yes" }, { v: "no", l: "No / not yet" }]} />
            </L>
            {f.plans === "yes" && (
              <L label="Are the plans approved by the county/city?">
                <Seg brand={brand} value={f.approved} onChange={(v) => set("approved", v as Form["approved"])} options={[{ v: "yes", l: "Yes" }, { v: "no", l: "Not yet" }, { v: "unsure", l: "Not sure" }]} />
              </L>
            )}
            {f.plans === "no" && (
              <L label="No problem — how can we picture it?">
                <Seg brand={brand} value={f.noPlansPath} onChange={(v) => set("noPlansPath", v as Form["noPlansPath"])} options={[{ v: "dimensions", l: "I have measurements" }, { v: "sketch", l: "I can send a sketch/photos" }, { v: "design_help", l: "I need design help" }]} />
              </L>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <L label="Length (ft)"><Num v={f.lengthFt} on={(n) => set("lengthFt", n)} field={field} ring={ring} /></L>
              <L label="Width / depth (ft)"><Num v={f.widthFt} on={(n) => set("widthFt", n)} field={field} ring={ring} /></L>
            </div>
            {est.area > 0 && <p className="text-sm text-slate-500">About <strong>{est.area.toLocaleString()} sq ft</strong>.</p>}
            <L label="Height at the tallest point">
              <select className={field} style={ring} value={f.heightBand} onChange={(e) => set("heightBand", e.target.value)}>
                {HEIGHT_BANDS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
              </select>
            </L>
            <L label="Decking material">
              <Seg brand={brand} value={f.material} onChange={(v) => set("material", v as DeckMaterial)} options={[{ v: "wood", l: "Wood" }, { v: "composite", l: "Composite (Trex / TimberTech)" }]} />
            </L>
            <L label="Shape">
              <Seg brand={brand} value={f.shape} onChange={(v) => set("shape", v as DeckShape)} options={[{ v: "rectangle", l: "Rectangular" }, { v: "irregular", l: "Irregular" }]} />
            </L>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={f.wrapAround} onChange={(e) => set("wrapAround", e.target.checked)} style={{ accentColor: brand }} />
              It wraps around the house
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <L label="Sets of stairs"><Num v={f.stairFlights} on={(n) => set("stairFlights", n)} field={field} ring={ring} /></L>
              <L label="Stair railing (ft)"><Num v={f.stairRailingLf} on={(n) => set("stairRailingLf", n)} field={field} ring={ring} /></L>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <L label="Doors onto the deck"><Num v={f.manDoors} on={(n) => set("manDoors", n)} field={field} ring={ring} /></L>
              <L label="Sliding doors onto the deck"><Num v={f.sliderDoors} on={(n) => set("sliderDoors", n)} field={field} ring={ring} /></L>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={f.trpa} onChange={(e) => set("trpa", e.target.checked)} style={{ accentColor: brand }} />
              The property is in the Lake Tahoe basin (TRPA)
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <input className={field} style={ring} placeholder="Your name *" value={f.name} onChange={(e) => set("name", e.target.value)} />
            <div className="grid grid-cols-2 gap-3">
              <input className={field} style={ring} placeholder="Phone" inputMode="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} />
              <input className={field} style={ring} placeholder="Email" inputMode="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
            </div>
            <AddressAutocomplete
              placeholder="Job address"
              onTextChange={(v) => set("address", v)}
              onResolved={(p) => { if (p.formatted) set("address", p.formatted); set("city", p.city); set("state", p.state); set("zip", p.zip); }}
            />
            <input value={f.hp} onChange={(e) => set("hp", e.target.value)} tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
          </div>
        )}
      </div>

      {/* Live estimate */}
      <EstimatePanel est={est} preview={preview} brand={brand} orgName={orgName} />

      {/* Nav */}
      <div className="mt-5 flex items-center justify-between">
        <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
          className="flex items-center gap-1 rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 disabled:opacity-0">
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        {step < 3 ? (
          <button type="button" onClick={() => setStep((s) => Math.min(3, s + 1))}
            className="flex items-center gap-1 rounded-lg px-5 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: brand }}>
            Next <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={busy}
            className="flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: brand }}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{busy ? "Sending…" : "Get my estimate"}
          </button>
        )}
      </div>
      <p className="mt-6 text-center text-xs text-slate-400">Powered by Contractor North</p>
    </div>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

function Num({ v, on, field, ring }: { v: number; on: (n: number) => void; field: string; ring: React.CSSProperties }) {
  return (
    <input type="number" min={0} inputMode="numeric" className={field} style={ring}
      value={v === 0 ? "" : v} placeholder="0" onChange={(e) => on(Math.max(0, Number(e.target.value) || 0))} />
  );
}

function Seg({ value, onChange, options, brand }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[]; brand: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value === o.v;
        return (
          <button key={o.v} type="button" onClick={() => onChange(o.v)}
            className="rounded-lg border px-3 py-2 text-sm font-medium transition"
            style={on ? { backgroundColor: brand, borderColor: brand, color: "#fff" } : { borderColor: "#cbd5e1", color: "#334155" }}>
            {o.l}
          </button>
        );
      })}
    </div>
  );
}

function EstimatePanel({ est, preview, brand, orgName }: { est: ReturnType<typeof computeDeckEstimate>; preview: ReturnType<typeof classifyLead>; brand: string; orgName: string }) {
  if (est.total <= 0) return null;
  return (
    <div className="mt-5 rounded-2xl border-2 p-5" style={{ borderColor: `${brand}55`, background: `${brand}0d` }}>
      {preview.showInstantPrice ? (
        <>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-slate-600">Preliminary estimate</span>
            <span className="text-3xl font-extrabold" style={{ color: brand }}>{money(est.total)}</span>
          </div>
          <ul className="mt-3 space-y-1 border-t border-slate-200 pt-3 text-sm text-slate-600">
            {est.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>{l.description} <span className="text-slate-400">· {l.quantity.toLocaleString()} {l.unit}</span></span>
                <span className="tabular-nums">{money(l.quantity * l.unit_price)}</span>
              </li>
            ))}
          </ul>
          {est.assumptions.length > 0 && (
            <p className="mt-3 text-xs text-slate-400">{est.assumptions.join(" ")}</p>
          )}
        </>
      ) : preview.siteInspectionRequired ? (
        <p className="text-sm text-slate-700">
          A project this size gets a <strong>free on-site visit</strong> for an exact price — {orgName} will reach out to schedule.
        </p>
      ) : (
        <p className="text-sm text-slate-700">
          {orgName} will reach out to talk through your project and put together the right plan.
        </p>
      )}
    </div>
  );
}

function ResultView({ result, orgName, brand, est }: { result: EstimateResult; orgName: string; brand: string; est: ReturnType<typeof computeDeckEstimate> }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-4 py-16 text-center">
      <CheckCircle2 className="h-14 w-14" style={{ color: brand }} />
      {result.showInstantPrice ? (
        <>
          <h1 className="mt-4 text-2xl font-extrabold text-slate-900">Your preliminary estimate</h1>
          <p className="mt-2 text-5xl font-extrabold" style={{ color: brand }}>{money(result.total ?? 0)}</p>
          {(result.lines?.length ?? 0) > 0 && (
            <ul className="mt-5 w-full space-y-1 rounded-2xl border border-slate-200 bg-white p-4 text-left text-sm text-slate-600">
              {result.lines!.map((l, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span>{l.description} <span className="text-slate-400">· {l.quantity.toLocaleString()} {l.unit}</span></span>
                  <span className="tabular-nums">{money(l.quantity * l.unit_price)}</span>
                </li>
              ))}
            </ul>
          )}
          {(result.assumptions?.length ?? 0) > 0 && <p className="mt-3 text-xs text-slate-400">{result.assumptions!.join(" ")}</p>}
          <p className="mt-4 text-slate-600">Sent to {orgName} — they'll reach out to confirm the details.</p>
        </>
      ) : result.siteInspectionRequired ? (
        <>
          <h1 className="mt-4 text-2xl font-extrabold text-slate-900">Thanks — you're on the list</h1>
          <p className="mt-2 text-slate-600">A project this size gets a free on-site visit for an exact price. {orgName} will reach out to schedule.</p>
        </>
      ) : (
        <>
          <h1 className="mt-4 text-2xl font-extrabold text-slate-900">Thanks — we've got it</h1>
          <p className="mt-2 text-slate-600">{orgName} will reach out to talk through your project.</p>
        </>
      )}
      <p className="mt-10 text-xs text-slate-400">Powered by Contractor North</p>
    </div>
  );
}
