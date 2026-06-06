import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";
import { FillForm } from "./fill-form";
import type { FormField } from "../actions";

export const dynamic = "force-dynamic";

function renderValue(v: unknown) {
  if (typeof v === "boolean") return v ? "✓ Yes" : "✗ No";
  if (v === "" || v == null) return "—";
  return String(v);
}

export default async function FormDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: form } = await supabase
    .from("forms")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!form) notFound();
  const fields = (form.schema ?? []) as FormField[];

  const [{ data: jobs }, { data: subs }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("form_submissions")
      .select("*, jobs(job_number, name), profiles:submitted_by(full_name)")
      .eq("form_id", id)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const submissions = subs ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/forms"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to forms
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{form.name}</h1>
        {form.description && (
          <p className="mt-1 text-sm text-slate-500">{form.description}</p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <CardContent className="py-5">
              <h3 className="mb-4 text-sm font-semibold text-slate-900">
                Fill out
              </h3>
              <FillForm formId={form.id} fields={fields} jobs={jobs ?? []} />
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card>
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Submissions ({submissions.length})
              </h3>
            </div>
            <ul className="divide-y divide-slate-100">
              {submissions.map((s: any) => (
                <li key={s.id} className="px-5 py-3">
                  <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                    <span>{s.profiles?.full_name ?? "—"}</span>
                    <span>{formatDateTime(s.created_at)}</span>
                  </div>
                  {s.jobs?.name && (
                    <div className="mb-1 text-xs font-medium text-slate-600">
                      {s.jobs.job_number} · {s.jobs.name}
                    </div>
                  )}
                  <dl className="space-y-0.5">
                    {fields.map((f) => (
                      <div key={f.key} className="flex justify-between gap-2 text-xs">
                        <dt className="text-slate-400">{f.label}</dt>
                        <dd className="text-right text-slate-700">
                          {renderValue(s.data?.[f.key])}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
              {submissions.length === 0 && (
                <li className="px-5 py-6 text-center text-sm text-slate-400">
                  No submissions yet.
                </li>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
