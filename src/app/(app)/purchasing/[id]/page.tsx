import Link from "next/link";
import { notFound } from "next/navigation";
import { Briefcase } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { createClient } from "@/lib/supabase/server";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { PoDetail, EditPoButton } from "./po-detail";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { purchaseOrderSectionTree } from "@/lib/nav-tree";
import { deletePurchaseOrder } from "../actions";
import type { PurchaseOrder, PurchaseOrderItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function PurchaseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: po, error: poErr } = await supabase
    .from("purchase_orders")
    .select("*, jobs(id, job_number, name)")
    .eq("id", id)
    .maybeSingle();

  if (poErr) throw poErr; // a real failure shouldn't masquerade as 404
  if (!po) notFound();
  const p = po as PurchaseOrder & { jobs: any };

  const [{ data: items, error: itemsErr }, { data: priceItems }, { data: jobs }] = await Promise.all([
    supabase
      .from("purchase_order_items")
      .select("*")
      .eq("po_id", id)
      // NO SECOND .order("created_at") HERE. Erik, bug 7a6b17a8: "PO empty even though it was
      // flagged with over $3k from somewhere." purchase_order_items has no created_at column —
      // line-item tables in this schema order by sort_order and nothing else (same for
      // invoice_items, quote_line_items, bill_line_items, material_list_items). PostgREST rejects
      // the WHOLE query for an unknown order column, so `items` came back null, the page rendered
      // an empty PO, and the header kept showing purchase_orders.total. PO-003's three lines were
      // in the database the entire time and sum to exactly the $3,274 he was staring at.
      .order("sort_order"),
    supabase
      .from("price_list_items")
      .select("id, code, description, unit, buy_price")
      .eq("archived", false)
      .order("description")
      .limit(2000),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  // A REJECTED READ MUST NOT LOOK LIKE AN EMPTY PO. This error was never checked, so a query the
  // database refused rendered as "this purchase order has no lines" — indistinguishable from a
  // real empty one, and sitting under a total that said otherwise. Same shape as the poErr throw
  // above: a real failure shouldn't masquerade as ordinary emptiness.
  if (itemsErr) throw itemsErr;

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink fallback="/bills" fallbackLabel="Back to Bills & Purchasing" />

      <div className="mb-6 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">{p.po_number}</h1>
          <Badge tone={statusTone(p.status)}>{p.status}</Badge>
          {/* Edit stays visible; the ⋯ Actions menu rides LAST as the seek door
              holding Delete (danger). The job link lives in the meta row below
              and Back owns the list, so neither is duplicated in the menu. */}
          <div className="ml-auto flex items-center gap-2">
            <EditPoButton
              poId={p.id}
              vendor={p.vendor}
              jobId={p.jobs?.id ?? null}
              jobs={(jobs ?? []) as { id: string; job_number: string; name: string }[]}
            />
            <SectionActionsMenu
              tree={purchaseOrderSectionTree(p.po_number, {
                run: deletePurchaseOrder.bind(null, p.id),
                confirm: `Delete ${p.po_number}? Its line items go with it.`,
              })}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <span className="font-medium text-slate-600">{p.vendor}</span>
          <span>Created {formatDate(p.created_at)}</span>
          {p.ordered_at && <span>Ordered {formatDate(p.ordered_at)}</span>}
          {p.jobs && (
            <Link
              href={`/jobs/${p.jobs.id}`}
              className="flex items-center gap-1 hover:text-brand"
            >
              <Briefcase className="h-3.5 w-3.5" /> {p.jobs.name}
            </Link>
          )}
        </div>
      </div>

      <PoDetail po={p} items={(items ?? []) as PurchaseOrderItem[]} priceItems={(priceItems ?? []) as any} />
    </div>
  );
}
