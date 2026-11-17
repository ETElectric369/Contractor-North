import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { currentLangFor } from "@/lib/current-lang";
import { todayStrInTz } from "@/lib/tz";
import { readMyPay } from "./my-pay-read";
import { MyPayList, MyPayNotice } from "./my-pay-views";

export const dynamic = "force-dynamic";

/**
 * MY PAY PERIODS (cn-v1166). The owner, 2026-11-16: "yes for tech sees all their own data and past pay
 * periods". The signed-in person's OWN periods, newest first, led by what the company still owes him for
 * closed hours. Every figure is the office's own (lib/payroll-math myPayPeriods, over the same rows the
 * Payroll page reads for him), so he reads the number he is paid against. Someone paid by owner's draw
 * has no pay periods and is told so in one line; a read that fails shows no figure at all.
 */
export default async function MyPayPeriodsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const lang = await currentLangFor(user?.id);
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const settings = getOrgSettings((org as any)?.settings);
  const tz = settings.timezone;
  const data = await readMyPay(supabase, user?.id ?? "", { tz, schedule: settings.pay_schedule, anchor: settings.pay_anchor, today: todayStrInTz(tz) });
  if (data.kind !== "ok") return <MyPayNotice lang={lang} kind={data.kind} />;
  return <MyPayList pay={data.pay} payments={data.payments} lang={lang} />;
}
