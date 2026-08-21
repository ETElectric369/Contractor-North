import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { assertOrgServable } from "@/lib/serve-org";
import { createServiceClient } from "@/lib/supabase/server";
import { playbookForForm } from "@/lib/playbook/parse";
import { publicIntakeNeeds } from "@/lib/playbook/public-intake";
import { IntakeForm } from "./intake-form";

export const dynamic = "force-dynamic";
// The segment's server actions inherit this budget. submitIntake finishes fast for the customer;
// the allowance is for the after() plan reading, which shares the same invocation.
export const maxDuration = 300;

/**
 * THE PUBLIC INTAKE DOOR — /intake/<handle>. The link a contractor puts on his own website
 * (Justin's Wix, a QR on the truck) so a customer walks themselves into the Leads board.
 *
 * Erik: "the inspector will be doing the job of collecting information — we need a playbook for
 * that or is it built in?" The engine is built in; this page is the door. It renders the org's
 * CUSTOMER-FACING intake playbook — a separate, small question set, never the walk-through,
 * because the walk-through is the contractor's own question set and its why lines are his pricing
 * logic. `publicIntakeNeeds` is an allowlist projection: `why` and `note` never leave the server.
 *
 * Reads through the service client by handle (the getPublicOrgByHandle pattern) — no anon RLS on
 * forms, so the table stays un-enumerable. The door is OFF unless the org flipped exactly one
 * form to is_public_intake in Settings → Website.
 */
export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) return {};
  return {
    title: `${org.name} — Request an estimate`,
    description: `Tell ${org.name} about your project and they'll get back to you.`,
    robots: { index: false }, // a form, not a page to rank — the org's site is the front door
  };
}

export default async function IntakePage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { handle } = await params;
  // ?embed=1 — the page inside an iframe on the org's OWN site (Justin's Wix). The host page
  // already carries their branding, so the header goes and the padding tightens; the questions
  // are the whole content. No frame-blocking headers are sent app-wide, so no carve-out needed.
  const { embed } = await searchParams;
  const embedded = embed === "1";
  const org = await getPublicOrgByHandle(handle);
  if (!org) notFound();
  await assertOrgServable(org.settings);

  const supabase = createServiceClient();
  const { data: form } = await supabase
    .from("forms")
    .select("id, schema, playbook")
    .eq("org_id", org.id)
    .eq("is_public_intake", true)
    .limit(1)
    .maybeSingle();
  if (!form) notFound(); // the off switch — no flagged form, no door

  const needs = publicIntakeNeeds(playbookForForm(form as { schema?: unknown; playbook?: unknown }));

  return (
    <main className={embedded ? "mx-auto max-w-xl px-2 py-4" : "mx-auto max-w-xl px-4 py-10"}>
      {!embedded && (
      <header className="mb-6">
        {org.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logo_url} alt="" className="mb-3 h-12 w-12 rounded-xl object-contain" />
        ) : null}
        <h1 className="text-2xl font-semibold text-slate-900">Request an estimate</h1>
        <p className="mt-1 text-sm text-slate-500">
          Tell {org.name} about your project — a few questions, a couple of minutes.
        </p>
      </header>
      )}
      <IntakeForm handle={handle} needs={needs} orgName={org.name} />
    </main>
  );
}
