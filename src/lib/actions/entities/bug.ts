import { z } from "zod";
import { createBugReport, setBugReportStatus } from "@/app/(app)/bug-report-actions";
import type { ActionDef } from "../types";

export const bugActions: Record<string, ActionDef> = {
  // Closes a known capability hole: Nort could LIST bug reports but not FILE one (it once
  // faked a capture because of exactly this class of gap). Same insert path as the UI's
  // report button (createBugReport — org-scoped via the set_org_id trigger + RLS).
  "bug.report": {
    name: "bug.report",
    group: "bug",
    label: "File a bug report",
    description:
      "File the user's bug reports and app feature requests so the dev team sees them — use for 'report this', 'the app is broken here', 'feature idea for the app'. Pass their words as the note (verbatim or lightly tidied) and, if they said where it happened, the page. Never pretend to file one — call this.",
    input: z.object({
      note: z.string().trim().min(1, "Tell me what happened.").max(4000),
      page: z.string().trim().max(300).optional(),
    }),
    auth: "any", // every org member can report a bug — matches createBugReport's gate
    effect: "write", // tier-1 (lowest write): one private row for the dev team; nothing sent
    handler: async (i) => {
      const res = await createBugReport({
        page: i.page || "/assistant", // filed from chat unless they named a page
        note: i.note,
        console: [],
        userAgent: "Filed via Nort",
        viewport: "",
      });
      return res.ok ? { ...res, speak: "Filed — the dev team will see it." } : res;
    },
  },
  "bug.resolve": {
    name: "bug.resolve",
    group: "bug",
    label: "Resolve a bug report",
    description:
      "Mark a bug report fixed, won't-fix, or re-open it — 'mark the scheduler nav bug as fixed'. Resolve the report with list_bug_reports first and pass its id (and the new status: fixed, wontfix, or open).",
    input: z.object({ id: z.string(), status: z.enum(["fixed", "wontfix", "open"]).default("fixed") }),
    auth: "staff",
    effect: "write",
    handler: (i) => setBugReportStatus(i.id, i.status),
  },
};
