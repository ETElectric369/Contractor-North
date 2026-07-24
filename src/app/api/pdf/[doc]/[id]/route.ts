import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // headless-chromium render can take a few seconds cold

/**
 * THE PDF engine (Erik 7/24): render any print document to a REAL PDF server-side with
 * headless Chromium, so margins and page breaks are decided HERE — deterministically —
 * instead of by whatever the customer's/owner's browser print dialog feels like doing.
 * The /print/<doc>/<id> HTML pages remain the single layout source (no duplicated
 * renderers); this route just prints them properly. `m` = margin inches (0.5/0.75/1).
 */
const DOCS: Record<string, string> = {
  invoice: "invoice",
  quote: "quote",
  "work-order": "work-order",
  "change-order": "change-order",
  "material-list": "material-list",
  "prelim-notice": "prelim-notice",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ doc: string; id: string }> }) {
  const { doc, id } = await ctx.params;
  const path = DOCS[doc];
  if (!path || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Unknown document." }, { status: 404 });

  // Staff-gated: these documents carry money and customer PII.
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { data: me } = await supabase.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if (!isStaffRole((me as { role?: string } | null)?.role)) {
    return NextResponse.json({ error: "Staff only." }, { status: 403 });
  }

  const url = new URL(req.url);
  const m = Math.min(1.25, Math.max(0.25, Number(url.searchParams.get("m")) || 0.75));
  const margin = `${m}in`;

  // Chromium: the Vercel lambda build on prod; a local Chrome for dev.
  const isVercel = !!process.env.VERCEL;
  const [{ default: puppeteer }, chromium] = await Promise.all([
    import("puppeteer-core"),
    isVercel ? import("@sparticuz/chromium").then((mod) => mod.default) : Promise.resolve(null as any),
  ]);
  const executablePath = isVercel
    ? await chromium.executablePath()
    : process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await puppeteer.launch({
    args: isVercel ? chromium.args : [],
    defaultViewport: isVercel ? chromium.defaultViewport : undefined,
    executablePath,
    headless: isVercel ? chromium.headless : true,
  });

  try {
    const page = await browser.newPage();
    // Forward THIS request's auth cookies so the print page renders as the signed-in user.
    const cookie = (await headers()).get("cookie");
    if (cookie) await page.setExtraHTTPHeaders({ cookie });
    await page.goto(`${url.origin}/print/${path}/${id}`, { waitUntil: "networkidle0", timeout: 45_000 });
    // Neutralize the on-screen sheet + toolbar: the PDF margin below is the ONE margin.
    await page.addStyleTag({
      content: `
        .no-print { display: none !important; }
        html, body { background: #fff !important; }
        .print-page { width: auto !important; max-width: none !important; min-height: 0 !important;
          padding: 0 !important; margin: 0 !important; box-shadow: none !important; border: none !important; }
        @page { margin: 0; }
      `,
    });
    const pdf = await page.pdf({
      format: "letter",
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: margin, right: margin, bottom: margin, left: margin },
    });

    // Friendly filename for invoices ("Invoice INV-048.pdf"); generic for the rest.
    let filename = `${doc}-${id.slice(0, 8)}.pdf`;
    if (doc === "invoice") {
      const { data: inv } = await supabase.from("invoices").select("invoice_number").eq("id", id).maybeSingle();
      if (inv?.invoice_number) filename = `Invoice ${inv.invoice_number}.pdf`;
    }

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    await browser.close();
  }
}
