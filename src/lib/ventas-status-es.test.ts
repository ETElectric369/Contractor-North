import { describe, it, expect } from "vitest";
import { translator } from "@/lib/i18n";
import { customerStatusLabel, inquiryStatusLabel, INQUIRY_STATUSES } from "@/lib/statuses";
import { LEAD_BUCKETS, PROJECT_TYPES, leadBucketWords, projectTypeLabel } from "@/lib/lead-triage";
import { CRM_SORT_OPTIONS, crmOrderLabel } from "@/lib/crm-order";
import { inspectionRowTags } from "@/lib/inspections";
import { leadNextStep, monthDay, visitsUnreadLabel, VISITS_UNREAD, VISITS_UNREAD_LABEL, weekdayMonthDay, type LeadStepInput } from "@/lib/leads/next-step";

/**
 * VENTAS-2'S FOUNDATION (cn-v1146): the two status helpers and the four libraries the leads, the
 * inspections tab and the customers read. English — the default, and what "en" with a translator
 * reads — is byte for byte what each said before; Spanish comes only through a caller's translator;
 * an unknown value reads as itself in both languages.
 */
const es = translator("es");
const en = translator("en");

describe("inquiryStatusLabel", () => {
  it("English is the raw value byte for byte, with or without a translator", () => {
    for (const s of INQUIRY_STATUSES) {
      expect(inquiryStatusLabel(s)).toBe(s);
      expect(inquiryStatusLabel(s, "en", en)).toBe(s);
      expect(inquiryStatusLabel(s, "es")).toBe(s); // no translator handed in: English, never a raw key
    }
  });
  it("Spanish reads the same words as the agenda's lead status family", () => {
    expect(INQUIRY_STATUSES.map((s) => inquiryStatusLabel(s, "es", es))).toEqual(["nuevo", "contactado", "cotizado", "ganado", "perdido"]);
    for (const s of INQUIRY_STATUSES) expect(inquiryStatusLabel(s, "es", es)).toBe(es(`ag_srv_leadStatus_${s}`));
  });
  it("an unknown value reads as itself in both languages", () => {
    expect(inquiryStatusLabel("archived", "es", es)).toBe("archived");
    expect(inquiryStatusLabel("archived")).toBe("archived");
    expect(inquiryStatusLabel("", "es", es)).toBe("");
  });
});

describe("customerStatusLabel", () => {
  it("English is the raw value; Spanish is the catalog's; unknown is itself", () => {
    expect(["lead", "active", "inactive"].map((s) => customerStatusLabel(s))).toEqual(["lead", "active", "inactive"]);
    expect(["lead", "active", "inactive"].map((s) => customerStatusLabel(s, "en", en))).toEqual(["lead", "active", "inactive"]);
    expect(["lead", "active", "inactive"].map((s) => customerStatusLabel(s, "es", es))).toEqual(["prospecto", "activo", "inactivo"]);
    expect(customerStatusLabel("vip", "es", es)).toBe("vip");
  });
});

describe("lib/lead-triage", () => {
  it("projectTypeLabel's English is PROJECT_TYPES' label byte for byte; Spanish differs; unknown is itself", () => {
    for (const p of PROJECT_TYPES) {
      expect(projectTypeLabel(p.value)).toBe(p.label);
      expect(projectTypeLabel(p.value, "en", en)).toBe(p.label);
      expect(projectTypeLabel(p.value, "es", es)).not.toBe(p.label);
    }
    expect(projectTypeLabel("railing", "es", es)).toBe("Solo barandal");
    expect(projectTypeLabel("gazebo", "es", es)).toBe("gazebo");
  });
  it("leadBucketWords' English is LEAD_BUCKETS byte for byte", () => {
    for (const b of ["A", "B", "C"] as const) {
      expect(leadBucketWords(b)).toEqual(LEAD_BUCKETS[b]);
      expect(leadBucketWords(b, "en", en)).toEqual(LEAD_BUCKETS[b]);
    }
    expect(leadBucketWords("C", "es", es).label).toBe("Consulta de diseño");
  });
});

describe("lib/crm-order crmOrderLabel", () => {
  it("English is CRM_SORT_OPTIONS' label; Spanish is Title Case; unknown is itself", () => {
    for (const o of CRM_SORT_OPTIONS) expect(crmOrderLabel(o.key)).toBe(o.label);
    expect(CRM_SORT_OPTIONS.map((o) => crmOrderLabel(o.key, "es", es))).toEqual(["Nombre", "Empresa", "Agregados Recientemente"]);
    expect(crmOrderLabel("zip", "es", es)).toBe("zip");
  });
});

describe("lib/inspections inspectionRowTags", () => {
  it("English by default, the tags in Spanish through a translator, tones unchanged", () => {
    const row = { type: "final_inspection", status: "cancelled", capture: null };
    expect(inspectionRowTags(row, true).map((t) => t.label)).toEqual(["Final Inspection", "cancelled", "no field notes"]);
    expect(inspectionRowTags({ ...row, status: "proposed" }, false).map((t) => t.label)).toEqual(["Final Inspection", "pending pick"]);
    const spanish = inspectionRowTags(row, true, "es", es);
    expect(spanish.map((t) => t.tone)).toEqual(inspectionRowTags(row, true).map((t) => t.tone));
    expect(spanish.map((t) => t.label).slice(1)).toEqual(["cancelada", "sin notas de campo"]);
    expect(spanish[0].label).toBe(es("jb_apptFinalInspection"));
  });
});

describe("lib/leads/next-step", () => {
  const base: LeadStepInput = {
    status: "new", converted_at: null, converted_to: null, next_follow_up_at: null,
    lead_bucket: null, site_inspection_required: null, source: null, referred_by: null,
  };
  const opts = { estimatesOn: true, tz: "America/Los_Angeles" };
  it("English is unchanged with no language and with 'en'", () => {
    expect(leadNextStep(base, null, "2026-11-06", opts).label).toBe("New · Call Them");
    expect(leadNextStep({ ...base, lead_bucket: "A", site_inspection_required: true }, null, "2026-11-06", opts, "en", en).label).toBe("A · New · Call Them · Needs A Visit");
    expect(leadNextStep({ ...base, next_follow_up_at: "2026-09-20" }, null, "2026-11-06", opts).label).toBe("Call Back · Sep 20");
    expect(leadNextStep(base, VISITS_UNREAD, "2026-11-06", opts).label).toBe(VISITS_UNREAD_LABEL);
    expect(visitsUnreadLabel()).toBe(VISITS_UNREAD_LABEL);
    expect(monthDay("2026-09-20")).toBe("Sep 20");
    expect(weekdayMonthDay("2026-10-01")).toBe("Thu Oct 1");
    expect(monthDay("2026-09-20", "en")).toBe("Sep 20");
  });
  it("Spanish through a translator; tone and bucket unchanged", () => {
    const step = leadNextStep({ ...base, lead_bucket: "A", site_inspection_required: true }, null, "2026-11-06", opts, "es", es);
    expect(step.label).toBe("A · Nuevo · Llámale · Necesita una Visita");
    expect(step.tone).toBe("blue");
    expect(step.bucket).toBe("A");
    expect(leadNextStep({ ...base, status: "lost" }, null, "2026-11-06", opts, "es", es).label).toBe("Perdido");
    expect(leadNextStep(base, VISITS_UNREAD, "2026-11-06", opts, "es", es).label).toBe("No Cargaron las Visitas");
    expect(leadNextStep({ ...base, next_follow_up_at: "2026-09-20" }, null, "2026-11-06", opts, "es", es).label).toMatch(/^Volver a Llamar · 20/);
    const booked = leadNextStep(base, { done: 0, upcoming: 1, nextAt: null, nextType: "inspection" }, "2026-11-06", opts, "es", es);
    expect(booked.label).toBe(`${es("ag_btn_kindInspection")} · Aún sin Día`);
  });
});
