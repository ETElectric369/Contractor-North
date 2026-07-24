import { PdfPreview } from "./viewer";

/** The WYSIWYG document preview (Erik 7/24): shows the REAL server-generated PDF —
 *  page boundaries and all — with a margin picker, instead of a run-on web page that
 *  only approximates what the print dialog will emit. Lives under /print (noindex). */
export default async function PdfPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string; id?: string; back?: string }>;
}) {
  const { doc = "invoice", id = "", back = "" } = await searchParams;
  return <PdfPreview doc={doc} id={id} back={back} />;
}
