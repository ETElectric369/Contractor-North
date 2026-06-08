import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Briefcase } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { PoDetail } from "./po-detail";
import type { PurchaseOrder, PurchaseOrderItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function PurchaseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: po } = await supabase
    .from("purchase_orders")
    .select("*, jobs(id, job_number, name)")
    .eq("id", id)
    .maybeSingle();

  if (!po) notFound();
  const p = po as PurchaseOrder & { jobs: any };

  const [{ data: items }, { data: priceItems }] = await Promise.all([
    supabase
      .from("purchase_order_items")
      .select("*")
      .eq("po_id", id)
      .order("sort_order")
      .order("created_at", { ascending: true }),
    supabase
      .from("price_list_items")
      .select("id, code, description, unit, buy_price")
      .eq("archived", false)
      .order("description")
      .limit(2000),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/bills"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Bills &amp; Purchasing
      </Link>

      <div className="mb-6 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">{p.po_number}</h1>
          <Badge tone={statusTone(p.status)}>{p.status}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <span className="font-medium text-slate-600">{p.vendor}</span>
          <span>Created {formatDate(p.created_at)}</span>
          {p.ordered_at && <span>Ordered {formatDate(p.ordered_at)}</span>}
          {p.jobs && (
            <Link
              href={`/work-orders?job=${p.jobs.id}`}
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
