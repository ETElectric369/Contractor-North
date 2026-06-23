import { Zap } from "lucide-react";
import type { CompanyInfo } from "./doc-letterhead";
import { companyBlock } from "@/lib/company-lines";

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

/** Option C letterhead: address block, then phone/email behind a brand accent rule,
 *  with the license emphasized. `onColor` adapts the palette for the modern band. */
function ContactBlock({ co, accent, onColor = false }: { co: CompanyInfo; accent: string; onColor?: boolean }) {
  const b = companyBlock(co);
  if (!b.address.length && !b.contact.length && !b.license) return null;
  const muted = onColor ? "rgba(255,255,255,0.72)" : "#64748b";
  const contact = onColor ? "rgba(255,255,255,0.9)" : "#475569";
  const strong = onColor ? "#ffffff" : "#0f172a";
  return (
    <div className="mt-2 text-[11px] leading-relaxed">
      {b.address.length > 0 && (
        <div className="space-y-0.5" style={{ color: muted }}>
          {b.address.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {(b.contact.length > 0 || b.license) && (
        <div className="mt-2 space-y-0.5 border-l-2 pl-2.5" style={{ borderColor: accent }}>
          {b.contact.map((l, i) => <div key={i} style={{ color: contact }}>{l}</div>)}
          {b.license && <div style={{ color: strong, fontWeight: 600 }}>{b.license}</div>}
        </div>
      )}
    </div>
  );
}

/** Company logo image if uploaded, otherwise a brand-colored placeholder mark. */
function Mark({ co, onColor = false }: { co: CompanyInfo; onColor?: boolean }) {
  if (co.logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={co.logo}
        alt={co.name}
        className={`h-12 w-auto max-w-[180px] object-contain ${
          onColor ? "rounded bg-white p-1" : ""
        }`}
      />
    );
  }
  return (
    <div
      className={`flex h-11 w-11 items-center justify-center rounded-lg ${
        onColor ? "bg-white/20 text-white" : "text-white"
      }`}
      style={onColor ? undefined : { backgroundColor: co.brand }}
    >
      <Zap className="h-6 w-6" />
    </div>
  );
}

export interface DocMeta {
  docType: string; // "Quote" | "Invoice" | "Change Order" | "Work Order"
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
  if (template === "modern") {
    return (
      <div
        className="-mx-10 -mt-10 mb-8 flex items-start justify-between px-10 py-8 text-white print:mb-4 print:py-5"
        style={{ backgroundColor: co.brand }}
      >
        <div className="flex items-center gap-3">
          <Mark co={co} onColor />
          <div>
            <div className="text-xl font-bold">{co.name}</div>
            <div className="text-xs text-white/80">{co.tagline}</div>
            <ContactBlock co={co} accent="rgba(255,255,255,0.6)" onColor />
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
        <div className="flex items-center gap-3">
          {co.logo && <Mark co={co} />}
          <div>
            <div className="text-lg font-semibold tracking-tight text-slate-900">
              {co.name}
            </div>
            <ContactBlock co={co} accent="#334155" />
          </div>
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
        <Mark co={co} />
        <div>
          <div className="text-xl font-bold text-slate-900">{co.name}</div>
          <div className="text-xs text-slate-500">{co.tagline}</div>
          <ContactBlock co={co} accent={co.brand} />
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

/** Resolve the template for a given doc type from the org's per-type map. */
export function templateFor(
  org: { doc_template?: string; doc_templates?: Record<string, string> } | null,
  docType: string,
): string {
  return (
    org?.doc_templates?.[docType] || org?.doc_template || "classic"
  );
}
