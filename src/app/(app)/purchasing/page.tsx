import Link from "next/link";
import { ShoppingCart } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { NewPoButton } from "./new-po-button";

export const dynamic = "force-dynamic";

export default async function PurchasingPage() {
  const supabase = await createClient();

  const [{ data: pos }, { data: jobs }, { data: lists }] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("*, jobs(job_number, name)")
      .order("created_at", { ascending: false }),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("material_lists")
      .select("id, name")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const orders = pos ?? [];

  return (
    <div>
      <PageHeader title="Purchasing" description="Purchase orders to CED and other vendors.">
        <NewPoButton jobs={jobs ?? []} lists={lists ?? []} />
      </PageHeader>

      {orders.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title="No purchase orders yet"
          description="Create a PO from scratch or seed it from a material list."
        >
          <NewPoButton jobs={jobs ?? []} lists={lists ?? []} />
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-12 gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
            <div className="col-span-2">PO #</div>
            <div className="col-span-3">Vendor</div>
            <div className="col-span-3">Job</div>
            <div className="col-span-2 text-right">Total</div>
            <div className="col-span-2 text-right">Status</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {orders.map((p: any) => (
              <li key={p.id}>
                <Link
                  href={`/purchasing/${p.id}`}
                  className="grid grid-cols-2 gap-2 px-5 py-3 hover:bg-slate-50 md:grid-cols-12 md:items-center md:gap-4"
                >
                  <div className="col-span-2 font-medium text-slate-900">
                    {p.po_number}
                  </div>
                  <div className="col-span-3 text-sm text-slate-600">{p.vendor}</div>
                  <div className="col-span-3 text-sm text-slate-500">
                    {p.jobs?.name ?? "—"}
                  </div>
                  <div className="col-span-2 text-right text-sm font-medium text-slate-900">
                    {formatCurrency(p.total)}
                  </div>
                  <div className="col-span-2 text-right">
                    <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
