import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { currentLangFor } from "@/lib/current-lang";
import { todayStrInTz } from "@/lib/tz";
import { entriesOfMyPeriod } from "@/lib/payroll-math";
import { readMyPay } from "../my-pay-read";
import { MyPayNotice, MyPayPeriodView } from "../my-pay-views";

export const dynamic = "force-dynamic";

/**
 * ONE OF MY PAY PERIODS (cn-v1166): its figures, its mileage, and its days with every entry. The address
 * is the period's first day and its exclusive end (2026-11-02_2026-11-16), and it must be one of the
 * signed-in person's own periods, read the same way the list reads them; anything else is not found.
 */
export default async function MyPayPeriodPage({ params }: { params: Promise<{ period: string }> }) {
  const { period: raw } = await params;
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(String(raw ?? ""));
  if (!m) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const lang = await currentLangFor(user?.id);
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const settings = getOrgSettings((org as any)?.settings);
  const tz = settings.timezone;
  const rule = { tz, schedule: settings.pay_schedule, anchor: settings.pay_anchor };
  // The one page that shows a job's name, so the only read that asks for the job's fields.
  const data = await readMyPay(supabase, user?.id ?? "", { ...rule, today: todayStrInTz(tz), withJobs: true });
  if (data.kind !== "ok") return <MyPayNotice lang={lang} kind={data.kind} />;
  const period = data.pay.periods.find((p) => p.start === m[1] && p.end === m[2]);
  if (!period) notFound();
  // Its entries by the same rule its figures were built by (a paid entry under the run that froze it).
  const entries = entriesOfMyPeriod(data.entries, data.runs, rule, period);
  return <MyPayPeriodView period={period} entries={entries} lang={lang} tz={tz} jobCodesOn={settings.timeclock_job_codes} />;
}
