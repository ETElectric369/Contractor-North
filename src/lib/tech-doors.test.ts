import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS } from "@/components/global-quick-add";
import { appointmentAffordances } from "@/lib/action-items/types";
import { canDeletePhoto } from "@/app/(app)/jobs/[id]/job-photos";

/**
 * NO DOOR A TECH CAN'T USE (Wave 0). Every page below was reachable by a tech and offered him a
 * save that requireStaff refused. Each one now reads the viewer's role and doesn't render the
 * door; these pins keep the gate from being dropped in a later edit.
 */
const src = (p: string) => readFileSync(join(process.cwd(), "src/app/(app)", p), "utf8");

describe("the office pages read the role and pass it down", () => {
  const pages: [string, string][] = [
    ["compliance/page.tsx", "<ComplianceManager"],
    ["insurance/page.tsx", "<InsuranceManager"],
    ["audits/page.tsx", "<AuditsManager"],
    ["safety/page.tsx", "<SafetyManager"],
    ["resources/page.tsx", "<ResourcesManager"],
  ];
  it.each(pages)("%s passes canEdit from isStaffRole", (page, tag) => {
    const s = src(page);
    expect(s).toContain("const canEdit = isStaffRole(");
    expect(s).toMatch(new RegExp(`${tag}[^>]*canEdit=\\{canEdit\\}`));
  });

  it("each manager hides its doors behind canEdit", () => {
    for (const f of ["compliance/compliance-manager.tsx", "insurance/insurance-manager.tsx", "audits/audits-manager.tsx", "safety/safety-manager.tsx", "resources/resources-manager.tsx"]) {
      expect(src(f)).toMatch(/\{canEdit && /);
    }
  });
});

describe("forms: a tech fills, the office builds", () => {
  it("New Form, Edit, Delete, Delete Submission and the Playbook link are staff-only", () => {
    expect(src("forms/page.tsx")).toContain("{isStaff && <NewFormButton />}");
    const detail = src("forms/[id]/page.tsx");
    expect(detail).toContain("{isStaff && <div");
    expect(detail).toContain("{isStaff && isPlaybook ? (");
    expect(detail).toContain("{isStaff && <DeleteSubmissionButton");
    // The fill itself stays for everyone (0195).
    expect(detail).toMatch(/<FillForm formId=\{form\.id\}/);
  });
});

describe("the job's side doors", () => {
  it("a work order: status, Edit and Delete are the office's; Print stays", () => {
    const s = src("work-orders/[id]/page.tsx");
    expect(s).toContain("{viewerIsStaff && <WoStatusControl");
    expect(s).toContain("{viewerIsStaff && <SectionActionsMenu");
    expect(s).toContain("Print / PDF");
  });

  it("a customer: Edit, New Job, Appointment and New Estimate are the office's; a markup never reaches a tech", () => {
    const s = src("crm/[id]/page.tsx");
    expect(s).toMatch(/viewerIsStaff\s*\?\s*supabase\.from\("pricing_levels"\)/);
    expect(s).toMatch(/\{viewerIsStaff && \(\s*<div className="flex flex-wrap items-center gap-2 border-t[^"]*">\s*<EditCustomerButton/);
    expect(s).toMatch(/\{viewerIsStaff && \(\s*<>\s*<NewJobButton/);
    expect(s).toContain('t.id !== "quotes" && t.id !== "invoices"');
  });

  it("an appointment: the office's verbs don't render for a tech; the walk-through is the office's, a crew lead's on his visit (0356), and read-only for anyone else", () => {
    const s = src("appointments/[id]/page.tsx");
    for (const tag of ["<SettleUpButton", "<MarkCompleteButton", "<ApptQuickActions", "<UnscheduleButton"]) {
      expect(s).toMatch(new RegExp(`\\{viewerIsStaff && [^\\n]*\\n\\s*${tag}`));
    }
    expect(s).toContain("{viewerIsStaff && !hasCaptureData(a.capture) &&");
    expect(s).toMatch(/\{viewerIsStaff && \(\s*<AppointmentButton/);
    // Who fills it in comes from one rule (lib/inspection/walkthrough-access), and a crew lead's door
    // is the database's probe of save_walkthrough_capture, never a guess.
    expect(s).toMatch(/const access = walkthroughAccess\(\{\s*isStaff: viewerIsStaff,/);
    expect(s).toContain('supabase.rpc("save_walkthrough_capture", { p_appointment: a.id })');
    expect(s).toContain("rpcReady: !!crewProbe && !crewProbe.error");
    expect(s).toContain("access={access}");
    // The price book and scope prices are the office's alone.
    expect(s).toContain("(viewerIsStaff ? (priceBook ?? []) : [])");
    expect(s).toMatch(/viewerIsStaff\s*\?\s*\(inspection\?\.inspection_answers \?\? \{\}\)\s*:\s*answersWithoutPrices\(/);
    expect(s).toContain("answers: answersWithoutPrices(b.answers)");
    expect(s).toMatch(/estimateHref=\{viewerIsStaff && estimatesOn \?/);
    // The heading names the estimate only for the people who get its door.
    expect(s).toContain('{viewerIsStaff && estimatesOn ? "Walk Through Or Estimate" : "Walk Through"}');
  });

  it("the jobs list offers New Job only to the office", () => {
    const s = src("jobs/page.tsx");
    expect(s).not.toMatch(/^\s*<NewJobButton/m);
    expect(s.match(/\{isStaff && <NewJobButton/g)?.length).toBe(2);
  });
});

describe("pure rules", () => {
  it("the quick-add menu gives a tech only New Task", () => {
    expect(ACTIONS.filter((a) => !a.staffOnly).map((a) => a.label)).toEqual(["New Task"]);
  });

  it("a tech's appointment row only opens", () => {
    expect(appointmentAffordances(false)).toEqual(["open"]);
    expect(appointmentAffordances(true)).toContain("do");
  });

  it("a photo's trash shows for the office, or for the one who took it", () => {
    expect(canDeletePhoto({ uploaded_by: "someone" }, "me", true)).toBe(true);
    expect(canDeletePhoto({ uploaded_by: "me" }, "me", false)).toBe(true);
    expect(canDeletePhoto({ uploaded_by: "someone" }, "me", false)).toBe(false);
    expect(canDeletePhoto({ uploaded_by: null }, "me", false)).toBe(false);
    expect(canDeletePhoto({ uploaded_by: null }, null, false)).toBe(false);
  });
});
