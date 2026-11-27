import Link from "next/link";
import { headers } from "next/headers";
import { Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isAppHostname } from "@/lib/public-host";

/** The request's host, read from the same "host" header the middleware's host rule reads; null
 *  when it cannot be read. */
async function requestHost(): Promise<string | null> {
  try {
    const host = (await headers()).get("host");
    return host && host.trim() ? host : null;
  } catch {
    return null;
  }
}

/** THE APP'S OWN MARK ONLY ON THE APP'S OWN HOST (cn-v1202). A dead customer link on a company's
 *  own domain (an invoice, a quote, the portal) renders this page, and that visitor is the
 *  company's customer, not the app's: there it draws the plain tile it drew before, with no
 *  "Contractor North" in it. On the app's host it draws the app icon, as the sign-in page does. A
 *  host that cannot be read gets the plain tile. Words and button are the same on both. */
export default async function NotFound() {
  const host = await requestHost();
  const appHost = host !== null && isAppHostname(host);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      {appHost ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-192.png" alt="Contractor North" className="mb-4 h-16 w-16 rounded-2xl shadow-sm" />
        </>
      ) : (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-white">
          <Zap className="h-6 w-6" />
        </div>
      )}
      <h1 className="text-3xl font-bold text-slate-900">404</h1>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        We couldn't find that page.
      </p>
      <Link href="/planner" className="mt-5">
        <Button>Back to Dashboard</Button>
      </Link>
    </div>
  );
}
