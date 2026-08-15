import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";

export const dynamic = "force-dynamic";
/** Concurrent chromium renders allowed per function instance (each is ~150MB). */
const MAX_CONCURRENT_RENDERS = 1;
let inFlight = 0;

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

/** Friendly filename — WITH THE JOB NAME for invoices (Erik: "we need to add the job name to
 *  the file name when sharing or exporting a file"). Shared by the stored-bytes and the
 *  fresh-render paths so the two can never disagree. */
async function docFilename(supabase: Awaited<ReturnType<typeof createClient>>, doc: string, id: string): Promise<string> {
  let filename = `${doc}-${id.slice(0, 8)}.pdf`;
  if (doc === "invoice") {
    const { data: inv } = await supabase
      .from("invoices")
      .select("invoice_number, jobs(name)")
      .eq("id", id)
      .maybeSingle();
    if (inv?.invoice_number) {
      const job = ((inv as { jobs?: { name?: string | null } | { name?: string | null }[] }).jobs ?? null);
      const jobName = String((Array.isArray(job) ? job[0]?.name : job?.name) ?? "").trim();
      filename = `Invoice ${inv.invoice_number}${jobName ? ` — ${jobName.slice(0, 60)}` : ""}.pdf`;
    }
  }
  return filename;
}

function pdfResponse(bytes: Uint8Array, filename: string) {
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      // Quote/newline-strip: invoice_number is settable via a direct PostgREST PATCH, and a
      // raw quote or CRLF in a header value is a response-splitting primitive.
      "Content-Disposition": `inline; filename="${filename.replace(/[\r\n"\\]/g, "")}"`,
      // no-store at the HTTP layer on purpose: the caching lives server-side, behind the
      // fingerprint check, where staleness is impossible. A browser-cached copy could go stale.
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ doc: string; id: string }> }) {
  const { doc, id } = await ctx.params;
  const path = DOCS[doc];
  if (!path || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Unknown document." }, { status: 404 });

  // Staff-gated: these documents carry money and customer PII.
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", auth.user.id).maybeSingle();
  if (!isStaffRole((me as { role?: string } | null)?.role)) {
    return NextResponse.json({ error: "Staff only." }, { status: 403 });
  }
  const orgId = (me as { org_id?: string | null } | null)?.org_id ?? null;

  const url = new URL(req.url);
  const m = Math.min(1.25, Math.max(0.25, Number(url.searchParams.get("m")) || 0.75));
  const margin = `${m}in`;

  /**
   * THE STORED COPY, WHEN NOTHING CHANGED (Erik: "once the pdf is created and nothing has been
   * edited … store it instead of regenerating over and over again", 0198).
   *
   * The fingerprint is a hash of the print page's HTML — the single layout source this route
   * renders anyway. One cheap HTML fetch replaces a ~5s chromium boot whenever the document is
   * unchanged; an edit, a payment landing, a logo swap or a fresh deploy all change the HTML,
   * so a stale PDF cannot be served and no per-table invalidation code exists to forget.
   * Erik's edit loop ("often i need to regenerate it exactly because im making edits") still
   * re-renders every time, because every edit moves the fingerprint.
   */
  const reqCookie = (await headers()).get("cookie");
  const printTarget = `${url.origin}/print/${path}/${id}`;
  let fingerprint: string | null = null;
  const svc = createServiceClient();
  try {
    const pre = await fetch(printTarget, {
      headers: reqCookie ? { cookie: reqCookie } : undefined,
      redirect: "manual",
      cache: "no-store",
    });
    if (pre.status === 200) {
      const visibleHtml = (await pre.text()).replace(/<script[\s\S]*?<\/script>/gi, "");
      fingerprint = createHash("sha256").update(visibleHtml).digest("hex");
      const { data: hit } = await svc
        .from("doc_pdf_cache")
        .select("fingerprint, path")
        .eq("doc", doc)
        .eq("doc_id", id)
        .eq("margin", m)
        .maybeSingle();
      if (hit?.fingerprint === fingerprint && hit.path) {
        const { data: blob } = await svc.storage.from("doc-pdfs").download(hit.path);
        if (blob) return pdfResponse(new Uint8Array(await blob.arrayBuffer()), await docFilename(supabase, doc, id));
      }
    }
  } catch {
    // The cache is a shortcut, never a gate — any failure here falls through to the render.
    fingerprint = null;
  }

  // Chromium: the Vercel lambda build on prod; a local Chrome for dev.
  const isVercel = !!process.env.VERCEL;
  // @sparticuz/chromium only extracts its shared libs (libnss3 et al) when it detects an
  // AWS runtime via AWS_EXECUTION_ENV / AWS_LAMBDA_JS_RUNTIME — and Vercel STRIPS those,
  // so no lib branch ever fired ("libnss3.so: cannot open shared object file"). Declare
  // the runtime ourselves BEFORE the module loads; Vercel functions run Amazon Linux 2023,
  // which is exactly the al2023 lib set this selects.
  if (isVercel && !process.env.AWS_LAMBDA_JS_RUNTIME) {
    process.env.AWS_LAMBDA_JS_RUNTIME = "nodejs22.x";
  }
  const [{ default: puppeteer }, chromium] = await Promise.all([
    import("puppeteer-core"),
    isVercel ? import("@sparticuz/chromium").then((mod) => mod.default) : Promise.resolve(null as any),
  ]);
  const executablePath = isVercel
    ? await chromium.executablePath()
    : process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  // One chromium per instance at a time: each launch is ~150MB and the render makes a SECOND
  // request back into this same deployment, so an unbounded fan-out (a user dragging the margin
  // control) can exhaust the function's memory and stall unrelated requests.
  if (inFlight >= MAX_CONCURRENT_RENDERS) {
    return NextResponse.json({ error: "Busy rendering — try again in a moment." }, { status: 429 });
  }
  inFlight++;
  let browser;
  try {
    browser = await puppeteer.launch({
      args: isVercel ? chromium.args : [],
      defaultViewport: isVercel ? chromium.defaultViewport : undefined,
      executablePath,
      headless: isVercel ? chromium.headless : true,
    });
  } catch (e) {
    // A launch failure must release the slot — otherwise the counter leaks and this
    // instance answers 429 forever.
    inFlight--;
    throw e;
  }

  try {
    const page = await browser.newPage();
    // Forward THIS request's auth cookies so the print page renders as the signed-in user —
    // but ONLY to our own origin. setExtraHTTPHeaders attaches a header to EVERY request the
    // rendered page makes, including cross-origin subresources (the org logo is a free-text
    // URL), which would hand the viewer's Supabase access+refresh token to whatever host that
    // URL names. Request interception lets us scope the credential to the app origin.
    const cookie = reqCookie;
    const target = printTarget;
    if (cookie) {
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        try {
          const sameOrigin = new URL(r.url()).origin === url.origin;
          void r.continue(sameOrigin ? { headers: { ...r.headers(), cookie } } : undefined);
        } catch {
          void r.continue();
        }
      });
    }
    const res = await page.goto(target, { waitUntil: "networkidle0", timeout: 25_000 });
    // A deleted/cross-org id renders the app's 404, and an expired session renders /login —
    // both come back HTTP 200, so without this the customer gets a beautifully typeset PDF of
    // an error page. The final-URL check is what catches the login redirect.
    if (!res || !res.ok() || new URL(res.url()).pathname !== `/print/${path}/${id}`) {
      return NextResponse.json({ error: "That document isn't available." }, { status: 404 });
    }
    // Neutralize the on-screen sheet + toolbar, and set the page margin via CSS @page —
    // Chromium IGNORES pdf()'s margin option whenever the page's stylesheets declare an
    // @page margin (our print CSS does), so CSS is the only channel that actually works
    // (verified locally: option-margins → content flush to every edge; CSS-margins → correct).
    await page.addStyleTag({
      content: `
        .no-print { display: none !important; }
        html, body { background: #fff !important; }
        .print-page { width: auto !important; max-width: none !important; min-height: 0 !important;
          padding: 0 !important; margin: 0 !important; box-shadow: none !important; border: none !important; }
        @page { margin: ${margin} !important; }
      `,
    });
    const pdf = await page.pdf({ format: "letter", printBackground: true });

    // KEEP THE BYTES (0198). Best-effort: a storage hiccup must never cost the response the
    // user is waiting on. The fingerprint is the one computed BEFORE the render — if the
    // pre-flight failed there is nothing safe to store under, so we skip.
    if (fingerprint && orgId) {
      try {
        const objPath = `${orgId}/${doc}/${id}/m${m}.pdf`;
        const up = await svc.storage
          .from("doc-pdfs")
          .upload(objPath, Buffer.from(pdf), { contentType: "application/pdf", upsert: true });
        if (!up.error) {
          // Stamp the doc's CURRENT status on the copy — the customer door (share-pdf) only
          // serves a copy whose stored status still matches, so a draft-era render or a
          // post-flip copy is refused there. The staff door doesn't read it.
          let docStatus = "";
          if (doc === "invoice" || doc === "quote") {
            const { data: d } = await svc.from(doc === "invoice" ? "invoices" : "quotes").select("status").eq("id", id).maybeSingle();
            docStatus = String((d as { status?: string } | null)?.status ?? "");
          }
          const { error: rowErr } = await svc
            .from("doc_pdf_cache")
            .upsert({ doc, doc_id: id, margin: m, fingerprint, path: objPath, org_id: orgId, doc_status: docStatus, updated_at: new Date().toISOString() });
          if (rowErr) console.error("doc_pdf_cache upsert failed", rowErr.message);
        }
      } catch (e) {
        console.error("pdf store failed", e instanceof Error ? e.message : e);
      }
    }

    return pdfResponse(new Uint8Array(pdf), await docFilename(supabase, doc, id));
  } finally {
    inFlight--;
    await browser.close();
  }
}
