import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { notSoldAnswer, undoneKey } from "./not-sold";

/**
 * A VISIT'S NOT SOLD AND ITS UNDO (cn-v1170): the toast says the lead went too only when the answer
 * said leadMarked; the Undo passes no option (the server reopens the lead by its own rule) and says
 * the lead is open again only when the server said leadReopened. A lead step that failed is shown.
 * The Inspections row's deed is run in its own test; the visit page's ending is pinned by its source.
 */
describe("notSoldAnswer", () => {
  it("leadMarked: the toast says the lead too", () => {
    expect(notSoldAnswer({ leadMarked: true })).toEqual({ said: "vp_markedLostLeadToo", warning: undefined });
  });
  it("no leadMarked, or false: the plain toast", () => {
    for (const res of [{}, { leadMarked: false }, { leadMarked: undefined }]) {
      expect(notSoldAnswer(res)).toEqual({ said: "vp_markedLost", warning: undefined });
    }
  });
  it("a warning rides along to be shown", () => {
    expect(notSoldAnswer({ warning: "Its lead couldn't be marked." }).warning).toBe("Its lead couldn't be marked.");
  });
});

describe("undoneKey", () => {
  it("the lead is said open again only when the server reopened it", () => {
    expect(undoneKey({ leadReopened: true })).toBe("vp_undoneLeadToo");
    for (const res of [{}, { leadReopened: false }]) expect(undoneKey(res)).toBeUndefined();
  });
  it("the visit page's ending passes no option on its Undo and shows a warning", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/appointments/[id]/visit-ending.tsx"), "utf8");
    expect(src).toContain("const a = notSoldAnswer(res);");
    expect(src).toContain("void setAppointmentOutcome(appointmentId, null).then(");
    expect(src).toContain('t(undoneKey(r) ?? "vp_answerCleared")');
    expect(src).toContain('if (a.warning) toast(a.warning, "error");');
    expect(src).toContain('if (r.ok && r.warning) toast(r.warning, "error");');
    expect(src).not.toContain("reopenLead");
    expect(src).not.toContain("undoOpts");
  });
});
