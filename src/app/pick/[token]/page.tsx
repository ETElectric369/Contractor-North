import { createClient } from "@/lib/supabase/server";
import { DatePicker } from "./date-picker";
import { accentHex } from "@/lib/org-settings";

export const dynamic = "force-dynamic";

/** Public page: the customer taps one of the offered dates — no login. */
export default async function PickDatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_schedule_proposal", { p_token: token });

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <p className="text-slate-500">This scheduling link isn&apos;t valid anymore.</p>
      </div>
    );
  }

  type Slot = string | { date: string; time?: string };
  const p = data as {
    org_name: string;
    logo_url: string | null;
    brand_color: string | null;
    phone: string | null;
    kind: string;
    label: string;
    address: string | null;
    time_note: string | null;
    dates: Slot[];
    status: string;
    chosen_date: string | null;
    chosen_at: string | null;
  };
  const brand = accentHex((p as { glass_tint?: string }).glass_tint);
  const hasTimes = (p.dates ?? []).some((d) => typeof d === "object");

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          {p.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.logo_url} alt={p.org_name} className="mx-auto mb-3 h-14 w-14 rounded-xl object-contain" />
          ) : (
            <div
              className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-xl text-xl font-bold text-white"
              style={{ background: brand }}
            >
              {p.org_name?.[0] ?? "C"}
            </div>
          )}
          <h1 className="text-xl font-bold text-slate-900">{p.org_name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Pick a {hasTimes ? "time" : "day"} that works for you — we&apos;ll lock it in.
          </p>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="mb-4 text-sm text-slate-600">
            <div className="font-medium text-slate-900">{p.label}</div>
            {p.address && <div className="text-xs text-slate-400">{p.address}</div>}
          </div>
          {p.time_note && (
            <div
              className="mb-4 rounded-xl px-3 py-2 text-sm font-medium"
              style={{ background: `${brand}14`, color: brand }}
            >
              Arrival window: {p.time_note}
            </div>
          )}
          <DatePicker token={token} dates={p.dates} status={p.status} chosen={p.chosen_date} brand={brand} />
        </div>

        {p.phone && (
          <p className="mt-4 text-center text-xs text-slate-400">
            None of these work? Call us: <a href={`tel:${p.phone}`} className="font-medium text-slate-600">{p.phone}</a>
          </p>
        )}
      </div>
    </div>
  );
}
