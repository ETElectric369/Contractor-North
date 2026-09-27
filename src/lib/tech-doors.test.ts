import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS } from "@/components/global-quick-add";
import { appointmentAffordances } from "@/lib/action-items/types";
import { canDeletePhoto } from "@/app/(app)/jobs/[id]/job-photos";
import { canDeleteTask } from "@/lib/job-tasks";

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
    // (and a switch's: Safety Log off takes New Form too, since a new form is a crew checklist)
    expect(src("forms/page.tsx")).toContain("{isStaff && safetyOn && <NewFormButton />}");
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
    // A why line names a price and a note is the owner's own voice: only the office gets the sheets as written.
    expect(s).toContain("templates={viewerIsStaff ? (sheets ?? []) : sheetsWithoutMoney(sheets ?? [])}");
    expect(s).toMatch(/estimateHref=\{viewerIsStaff && estimatesOn \?/);
    // The heading names the estimate only for the people who get its door.
    expect(s).toContain('{viewerIsStaff && estimatesOn ? "Walk Through Or Estimate" : "Walk Through"}');
  });

  it("the job's Tasks card is the crew's too: the Overview and the Tasks tab render it for every role (0358)", () => {
    const s = src("jobs/[id]/page.tsx");
    // Not behind a role gate: the same card, the same list, for the office and the crew.
    expect(s).toMatch(/\n\s*<JobTaskList mode="card" \{\.\.\.taskListProps\} \/>/);
    expect(s).toContain('content: <JobTaskList mode="tab" {...taskListProps} />');
    expect(s).not.toMatch(/viewerIsStaff\s*&&\s*<JobTaskList/);
    // The role decides only the Delete (canDeleteTask), passed down, never the list.
    expect(s).toMatch(/taskListProps = \{[\s\S]*viewerIsStaff,[\s\S]*\};/);
    // The dock's Tasks slot is gone: the pinned chip next to Overview is the one door.
    expect(src("jobs/[id]/job-action-dock.tsx")).not.toContain("?tab=tasks");
  });

  it("the jobs list offers New Job only to the office", () => {
    const s = src("jobs/page.tsx");
    expect(s).not.toMatch(/^\s*<NewJobButton/m);
    expect(s.match(/\{isStaff && <NewJobButton/g)?.length).toBe(2);
  });

  it("Already Billed (0357) is the office's: its doors come off the staff-only piles, its reads are staff-only, and a job New Invoice bills by its contract gets only the way back", () => {
    const s = src("jobs/[id]/page.tsx");
    // The piles exist only for staff on a job whose running total was read: one that bills its
    // actuals, or (for the office) one whose next New Invoice pulls them, New Invoice's own rule.
    expect(s).toMatch(/const costGroups =\s*viewerIsStaff && unbilled && unbilled\.schemaReady/);
    expect(s).toMatch(/pilesOn\s*\?\s*unbilledWorkForJob\(/);
    expect(s).toMatch(/const pilesOn = billsActuals \|\| \(viewerIsStaff && importsActuals\);/);
    expect(s).toMatch(/const importsActuals = nextInvoiceImportsActuals\(/);
    // The doors' reach is read for staff only, by the sheet's own rule.
    expect(s).toMatch(/viewerIsStaff &&\s*importsActuals &&[\s\S]{0,200}\?\s*readAlreadyBilledReach\(/);
    // The marks are read for staff only (on any job: the way back is wherever a mark is).
    expect(s).toMatch(/viewerIsStaff\s*\?\s*readHandClaimsForJob\(/);
    expect(s).toMatch(/const handById = handClaims && handClaims !== "failed" && handClaims\.ready \? handClaims\.byId : null;/);
    // Every door and Undo is built from the piles or the staff-only marks; an open row's door only from the piles.
    expect(s).toMatch(/const alreadyBilledDoors =\s*costGroups \|\| \(handById && handById\.size > 0\)/);
    expect(s).toMatch(/offer: costGroups \? alreadyBilledCan : \{ charge: false, ret: false \}/);
    expect(s).toMatch(/const hoursMarked = hoursByHand\(\(laborRows\?\.jobEntries \?\? \[\]\) as any\[\], handById\);/);
    // The hours door sits in the Not Billed Yet aside, which renders only with the piles.
    expect(s).toMatch(/costGroups && unbilled \? \(\s*<div className="space-y-2">/);
    expect(s).toContain("alreadyBilled={alreadyBilledDoors}");
  });

  it("a database without 0357 draws no Already Billed door (every sheet it opened would only say it needs an update)", () => {
    // The job's Costs tab: a reach read that is not ready is "nothing can hold it", never the
    // lost-read fallback that offers the doors wherever a sent bill is.
    const job = src("jobs/[id]/page.tsx");
    expect(job).toMatch(/r\.ready \? \(r\.jobs\.get\(id\) \?\? \{ charge: false, ret: false \}\) : \{ charge: false, ret: false \}/);
    // The invoice page's Already Billed: Hours On No Job: only once the hands read is ready (a lost
    // read still shows it; the sheet says what it finds).
    const inv = src("billing/[id]/page.tsx");
    expect(inv).toMatch(/const noJobReady = !\(noJobHands && noJobHands !== "failed" && !noJobHands\.ready\);/);
    expect(inv).toMatch(/const noJobDoor = noJobDoorHere && noJobReady && openNoJob !== 0;/);
  });
});

describe("pure rules", () => {
  it("the + gives a tech no typed verb: his + is Snap Or Note (W1-11)", () => {
    expect(ACTIONS.filter((a) => !a.staffOnly).map((a) => a.label)).toEqual([]);
  });

  it("a tech's appointment row only opens", () => {
    expect(appointmentAffordances(false)).toEqual(["open"]);
    expect(appointmentAffordances(true)).toContain("do");
  });

  it("a job task's Delete shows for the office, or for the one who added it (0358)", () => {
    expect(canDeleteTask({ created_by: "someone" }, "me", true)).toBe(true);
    expect(canDeleteTask({ created_by: "me" }, "me", false)).toBe(true);
    expect(canDeleteTask({ created_by: "someone" }, "me", false)).toBe(false);
    expect(canDeleteTask({ created_by: null }, "me", false)).toBe(false);
  });

  it("a photo's trash shows for the office, or for the one who took it", () => {
    expect(canDeletePhoto({ uploaded_by: "someone" }, "me", true)).toBe(true);
    expect(canDeletePhoto({ uploaded_by: "me" }, "me", false)).toBe(true);
    expect(canDeletePhoto({ uploaded_by: "someone" }, "me", false)).toBe(false);
    expect(canDeletePhoto({ uploaded_by: null }, "me", false)).toBe(false);
    expect(canDeletePhoto({ uploaded_by: null }, null, false)).toBe(false);
  });
});
