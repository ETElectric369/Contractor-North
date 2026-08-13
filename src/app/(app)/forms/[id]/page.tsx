import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BackLink } from "@/components/back-link";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";
import { FillForm } from "./fill-form";
import { EditFormButton } from "./edit-form-button";
import { DeleteFormButton } from "./delete-form-button";
import { DeleteSubmissionButton } from "./delete-submission-button";
import type { FormField } from "../actions";
import { jobLabel } from "@/lib/schedule-options";
import { parsePlaybook } from "@/lib/playbook/parse";

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
  // A REAL playbook, not merely a non-null column: parsePlaybook is the tolerant reader every
  // other surface uses, and `{}` or `{needs: []}` must not count as one.
  const isPlaybook = parsePlaybook((form as { playbook?: unknown }).playbook).needs.length > 0;

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
      <BackLink fallback="/forms" fallbackLabel="Back to Forms" />

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{form.name}</h1>
          {form.description && (
            <p className="mt-1 text-sm text-slate-500">{form.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* NO EDIT BUTTON ON A PLAYBOOK-BACKED FORM. The fields below are a MIRROR of the
              playbook, regenerated on every playbook save, so an edit here has nowhere to go —
              which is how Andrew deleted his website's Budget question, got a success, and
              changed nothing. updateForm refuses the write too; this is so he never finds the
              door in the first place. */}
          {!isPlaybook && (
            <EditFormButton
              formId={form.id}
              name={form.name}
              description={form.description}
              isInspection={!!(form as { is_inspection?: boolean }).is_inspection}
              fields={fields}
            />
          )}
          <DeleteFormButton formId={form.id} />
        </div>
      </div>

      {/* A SHEET EDITOR THAT SILENTLY DOES NOTHING IS WORSE THAN NO EDITOR. Once this form has a
          playbook (0179) the inspector asks from the playbook, so editing the fields here would
          look like it worked and change nothing on a job site. Say where the real edit lives. */}
      {isPlaybook ? (
        <div className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>
            {(form as { is_public_intake?: boolean }).is_public_intake
              ? "These are the questions on your website. What you see below is a read-only copy — editing it here would change nothing."
              : "This walk-through is a playbook now — the questions below are a copy of its closed half."}
          </span>
          {/* CARRIES THE FORM ID. Without it the editor opens on whichever form it defaults to,
              which for an org with both a website form and a walk-through is the other one —
              so "edit it over there" landed on ten questions that were not the ones he came to
              change, and looked like a playbook that refused to show him his own work. */}
          <Link href={`/settings?tab=playbook&form=${form.id}`} className="font-medium underline underline-offset-2">
            Edit it in Settings &rarr; Playbook
          </Link>
        </div>
      ) : null}

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
                    <div className="flex items-center gap-1.5">
                      <span>{formatDateTime(s.created_at)}</span>
                      <DeleteSubmissionButton submissionId={s.id} formId={form.id} />
                    </div>
                  </div>
                  {s.jobs?.name && (
                    <Link href={`/jobs/${s.job_id}`} className="mb-1 block text-xs font-medium text-slate-600 hover:text-brand">
                      {jobLabel(s.jobs)}
                    </Link>
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
