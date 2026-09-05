import Link from "next/link";
import { headers } from "next/headers";
import { shellFromUserAgent } from "@/lib/native-shell";
import { NO_INDEX } from "@/lib/no-index";
import { Zap } from "lucide-react";
import { requestPasswordReset } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { error, message } = await searchParams;
  // IN THE APP, THE RESET LINK IS A DEAD END (audit v921 high). The emailed link carries a PKCE
  // code that can only be exchanged in the browser context that ASKED for it; the shell (and the
  // installed PWA) hand the link to Safari, whose cookie jar has no verifier — the exchange fails
  // every time. The 6-digit code path has no such problem, so in the shell that is the door we
  // lead with. Web keeps the link.
  const inShell = shellFromUserAgent((await headers()).get("user-agent")).native;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
            <Zap className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Reset your password</h1>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-xl">
          <p className="mb-6 text-sm text-slate-500">
            {inShell
              ? "In the app, sign in with a 6-digit code — then set a new password in Settings. A reset link would open in Safari and can't finish there."
              : "Enter your email and we'll send you a link to set a new password."}
          </p>

          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {message && (
            <div className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
              {message}
            </div>
          )}

          {inShell ? (
            <Link href="/login?mode=code" className="block">
              <Button size="lg" className="w-full">
                Sign In With A Code
              </Button>
            </Link>
          ) : (
            <form action={requestPasswordReset} className="space-y-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" placeholder="you@company.com" required />
              </div>
              <Button type="submit" size="lg" className="w-full">
                Send Reset Link
              </Button>
            </form>
          )}

          {!inShell && (
            <p className="mt-4 text-center text-sm text-slate-500">
              Didn&apos;t get it, or the link won&apos;t open?{" "}
              <Link href="/login?mode=code" className="font-medium text-brand hover:underline">
                Sign in with a code
              </Link>
            </p>
          )}

          <p className="mt-6 text-center text-sm text-slate-500">
            <Link href="/login" className="font-medium text-brand hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

// Never index auth/utility chrome — on a tenant's custom domain this page previously leaked a
// "Contractor North" title into crawlers with no noindex (the SEO vendor's "hosted on
// contractornorth" ammunition). Both layers per the no-index doctrine: this metadata + robots.txt.
export const metadata = { title: "Reset your password", robots: NO_INDEX };
