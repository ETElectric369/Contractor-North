import { pickSite } from "@/lib/site-address";
import { companyFromOrg } from "@/components/doc-letterhead";
import { templateFor } from "@/components/doc-templates";
import { invoiceTypeLabel } from "@/lib/invoice-math";
import { InvoiceDocument } from "@/components/invoice-document";
import type { Organization } from "@/lib/types";

/**
 * THE CUSTOMER'S COPY OF A BILL, FROM THE PUBLIC PROJECTION: public_invoice's result (the /i link)
 * and the portal job page's `doc` (the same invoice_document_projection, 0301) both land here, so
 * a customer reads one bill the same way through either door. Only the prop mapping lives here;
 * the document itself is InvoiceDocument, shared with print and the in-app preview.
 */
export type PublicInvoiceData = {
  invoice: Record<string, any>;
  items?: Record<string, any>[] | null;
  payments?: { amount: number; paid_at: string; method: string | null }[] | null;
  customer?: Record<string, any> | null;
  site_candidates?: unknown[] | null;
  org?: Record<string, any> | null;
};

/** groupByKind: the customer portal's bill, its lines under Labor / Materials / ... headings with
 *  subtotals (InvoiceDocument). The /i page leaves it off and prints the bill as it always has. */
export function PublicInvoiceDocument({ data, groupByKind = false }: { data: PublicInvoiceData; groupByKind?: boolean }) {
  const inv = data.invoice;
  const org = (data.org ?? null) as (Organization & Record<string, any>) | null;
  const co = companyFromOrg(org);
  return (
    <InvoiceDocument
      docStyle={org?.doc_style}
      site={pickSite([
        ...((data.site_candidates ?? []) as never[]),
        { source: "customer", parts: data.customer as never },
      ])}
      co={co}
      template={templateFor(org, "invoice")}
      number={inv.invoice_number}
      createdAt={inv.created_at}
      dueDate={inv.due_date}
      title={inv.title}
      billingLabel={invoiceTypeLabel(inv.billing_type, inv.invoice_kind)}
      description={inv.description}
      customer={data.customer as never}
      items={(data.items ?? []) as never[]}
      subtotal={inv.subtotal}
      taxRate={inv.tax_rate}
      tax={inv.tax}
      total={inv.total}
      amountPaid={inv.amount_paid}
      // public_invoice has returned all three since 0247/0283; the page just never passed them,
      // so the customer's live link showed less than the PDF of the same bill.
      payments={(data.payments ?? []) as never[]}
      notes={inv.notes}
      terms={(org?.invoice_terms as string | null | undefined) ?? null}
      documentFooter={(org?.document_footer as string | null | undefined) ?? null}
      invoiceKind={(inv.invoice_kind as string | null | undefined) ?? null}
      groupByKind={groupByKind}
    />
  );
}
