import { describe, it, expect } from "vitest";
import { translator } from "@/lib/i18n";
import { customerStatusLabel, inquiryStatusLabel, INQUIRY_STATUSES } from "@/lib/statuses";
import { LEAD_BUCKETS, PROJECT_TYPES, leadBucketWords, projectTypeLabel } from "@/lib/lead-triage";
import { CRM_SORT_OPTIONS, crmOrderLabel } from "@/lib/crm-order";
import { inspectionRowTags } from "@/lib/inspections";

/**
 * VENTAS-2'S FOUNDATION (cn-v1146): the two status helpers and the four libraries the leads, the
 * inspections tab and the customers read. English — the default, and what "en" with a translator
 * reads — is byte for byte what each said before; Spanish comes only through a caller's translator;
 * an unknown value reads as itself in both languages.
 */
const es = translator("es");
const en = translator("en");

describe("inquiryStatusLabel", () => {
  it("English is the raw value byte for byte, with or without a translator, except lost, which reads not sold (cn-v1170)", () => {
    for (const s of INQUIRY_STATUSES) {
      const word = s === "lost" ? "not sold" : s;
      expect(inquiryStatusLabel(s)).toBe(word);
      expect(inquiryStatusLabel(s, "en", en)).toBe(word);
      expect(inquiryStatusLabel(s, "es")).toBe(word); // no translator handed in: English, never a raw key
    }
    // The English word is the agenda's lead status family's, the same as Spanish below.
    for (const s of INQUIRY_STATUSES) expect(inquiryStatusLabel(s)).toBe(en(`ag_srv_leadStatus_${s}`));
  });
  it("Spanish reads the same words as the agenda's lead status family", () => {
    expect(INQUIRY_STATUSES.map((s) => inquiryStatusLabel(s, "es", es))).toEqual(["nuevo", "contactado", "cotizado", "ganado", "no vendido"]);
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
