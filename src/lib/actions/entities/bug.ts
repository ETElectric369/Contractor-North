import { z } from "zod";
import { setBugReportStatus } from "@/app/(app)/bug-report-actions";
import type { ActionDef } from "../types";

export const bugActions: Record<string, ActionDef> = {
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
