import Link from "next/link";
import { login, signup, sendLoginCode, verifyLoginCode } from "./actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; mode?: string; email?: string; sent?: string }>;
}) {
  const { error, message, mode, email, sent } = await searchParams;
  const isSignup = mode === "signup";
  const isCode = mode === "code";
  const codeSent = isCode && sent === "1";

  const heading = isSignup ? "Create your account" : isCode ? "Sign in with a code" : "Sign in";
  const sub = isSignup
    ? "Set up your account to get started."
    : isCode
      ? codeSent
        ? "Enter the 6-digit code we just emailed you."
        : "No password needed — we'll email you a code."
      : "Welcome back.";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-white p-1.5 shadow-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/cn-logo.svg" alt="Contractor North" className="h-full w-full" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Contractor North</h1>
          <p className="mt-1 text-sm text-white/80">Field service platform for electrical contractors</p>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-xl">
          <h2 className="mb-1 text-lg font-semibold text-slate-900">{heading}</h2>
          <p className="mb-6 text-sm text-slate-500">{sub}</p>

          {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
          {message && <div className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">{message}</div>}

          {isCode ? (
            codeSent ? (
              // ── Enter the 6-digit code ──
              <form className="space-y-4">
                <input type="hidden" name="email" value={email ?? ""} />
                <div>
                  <Label htmlFor="code">6-digit code</Label>
                  <Input
                    id="code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="123456"
                    required
                    autoFocus
                    className="text-center text-2xl tracking-[0.4em]"
                  />
                  <p className="mt-1 text-xs text-slate-400">Sent to {email} — enter the code, or just tap the sign-in link in the email. Check spam if it&apos;s not there.</p>
                </div>
                <Button type="submit" className="w-full" size="lg" formAction={verifyLoginCode}>
                  Verify &amp; sign in
                </Button>
                <div className="flex items-center justify-between text-xs">
                  <button formAction={sendLoginCode} formNoValidate className="font-medium text-brand hover:underline">
                    Resend code
                  </button>
                  <Link href="/login" className="text-slate-500 hover:underline">Use a password instead</Link>
                </div>
              </form>
            ) : (
              // ── Request a code ──
              <form className="space-y-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" name="email" type="email" placeholder="you@company.com" defaultValue={email ?? ""} required autoFocus />
                </div>
                <Button type="submit" className="w-full" size="lg" formAction={sendLoginCode}>
                  Email me a code
                </Button>
                <p className="text-center text-xs">
                  <Link href="/login" className="text-slate-500 hover:underline">Use a password instead</Link>
                </p>
              </form>
            )
          ) : (
            // ── Password login / signup ──
            <form className="space-y-4">
              {isSignup && (
                <div>
                  <Label htmlFor="full_name">Full name</Label>
                  <Input id="full_name" name="full_name" placeholder="Jane Sparks" required />
                </div>
              )}
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" placeholder="you@company.com" defaultValue={email ?? ""} required />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <Label htmlFor="password" className="mb-0">Password</Label>
                  {!isSignup && <Link href="/forgot" className="text-xs font-medium text-brand hover:underline">Forgot Password?</Link>}
                </div>
                <PasswordInput id="password" name="password" placeholder="••••••••" required minLength={6} />
              </div>

              <Button type="submit" className="w-full" size="lg" formAction={isSignup ? signup : login}>
                {isSignup ? "Create Account" : "Sign In"}
              </Button>

              {!isSignup && (
                <p className="text-center text-xs">
                  <Link href="/login?mode=code" className="font-medium text-brand hover:underline">
                    Sign in with a code instead — no password
                  </Link>
                </p>
              )}
            </form>
          )}

          <p className="mt-6 text-center text-sm text-slate-500">
            {isSignup ? (
              <>Already have an account? <Link href="/login" className="font-medium text-brand hover:underline">Sign In</Link></>
            ) : (
              <>Need an account? <Link href="/login?mode=signup" className="font-medium text-brand hover:underline">Sign up</Link></>
            )}
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-white/60">Service · Integrity · Reliability</p>
      </div>
    </div>
  );
}
