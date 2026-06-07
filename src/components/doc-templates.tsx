import { Zap } from "lucide-react";
import type { CompanyInfo } from "./doc-letterhead";

export type DocTemplate = "classic" | "modern" | "minimal";

export const DOC_TEMPLATES: { id: DocTemplate; name: string; desc: string }[] = [
  { id: "classic", name: "Classic", desc: "Logo left, brand underline. Clean and traditional." },
  { id: "modern", name: "Modern", desc: "Bold brand-colored header band with white text." },
  { id: "minimal", name: "Minimal", desc: "Monochrome, understated, lots of whitespace." },
];

/** Accent color for a template — brand color, except Minimal which is neutral. */
export function docAccent(co: CompanyInfo, template: string): string {
  return template === "minimal" ? "#334155" : co.brand;
}

function metaLine(co: CompanyInfo): string {
  return [
    [co.address1, co.address2].filter(Boolean).join(", "),
    co.cityStateZip,
    co.phone,
    co.email,
    co.license,
  ]
    .filter(Boolean)
    .join(" · ");
}

export interface DocMeta {
  docType: string; // "Quote" | "Invoice"
  number: string;
  rows: { label: string; value: string }[];
}

/** Renders the document header in the chosen template style. */
export function DocHeader({
  co,
  template,
  meta,
}: {
  co: CompanyInfo;
  template: string;
  meta: DocMeta;
}) {
  const info = metaLine(co);

  if (template === "modern") {
    return (
      <div
        className="-mx-10 -mt-10 mb-8 flex items-start justify-between px-10 py-8 text-white"
        style={{ backgroundColor: co.brand }}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-white/20">
            <Zap className="h-6 w-6" />
          </div>
          <div>
            <div className="text-xl font-bold">{co.name}</div>
            <div className="text-xs text-white/80">{co.tagline}</div>
            {info && <div className="mt-1 max-w-sm text-[11px] text-white/70">{info}</div>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold uppercase tracking-wide">{meta.docType}</div>
          <div className="mt-1 text-sm font-medium">{meta.number}</div>
          {meta.rows.map((r) => (
            <div key={r.label} className="text-xs text-white/80">
              {r.label}: {r.value}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (template === "minimal") {
    return (
      <div className="mb-8 flex items-end justify-between border-b border-slate-300 pb-4">
        <div>
          <div className="text-lg font-semibold tracking-tight text-slate-900">
            {co.name}
          </div>
          {info && <div className="mt-1 max-w-sm text-[11px] text-slate-500">{info}</div>}
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            {meta.docType}
          </div>
          <div className="text-sm text-slate-800">{meta.number}</div>
          {meta.rows.map((r) => (
            <div key={r.label} className="text-xs text-slate-400">
              {r.label}: {r.value}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // classic (default)
  return (
    <div
      className="mb-6 flex items-start justify-between border-b-2 pb-5"
      style={{ borderColor: co.brand }}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex h-11 w-11 items-center justify-center rounded-lg text-white"
          style={{ backgroundColor: co.brand }}
        >
          <Zap className="h-6 w-6" />
        </div>
        <div>
          <div className="text-xl font-bold text-slate-900">{co.name}</div>
          <div className="text-xs text-slate-500">{co.tagline}</div>
          {info && <div className="mt-1 text-xs text-slate-500">{info}</div>}
        </div>
      </div>
      <div className="text-right">
        <div className="text-2xl font-bold uppercase tracking-wide text-slate-900">
          {meta.docType}
        </div>
        <div className="mt-1 text-sm font-medium text-slate-700">{meta.number}</div>
        {meta.rows.map((r) => (
          <div key={r.label} className="text-xs text-slate-500">
            {r.label}: {r.value}
          </div>
        ))}
      </div>
    </div>
  );
}
