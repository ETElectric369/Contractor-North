import Link from "next/link";
import { login, signup } from "./actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    message?: string;
    mode?: string;
    email?: string;
  }>;
}) {
  const { error, message, mode, email } = await searchParams;
  const isSignup = mode === "signup";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-white p-1.5 shadow-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/cn-logo.svg" alt="Contractor North" className="h-full w-full" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Contractor North</h1>
          <p className="mt-1 text-sm text-white/80">
            Field service platform for electrical contractors
          </p>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-xl">
          <h2 className="mb-1 text-lg font-semibold text-slate-900">
            {isSignup ? "Create your account" : "Sign in"}
          </h2>
          <p className="mb-6 text-sm text-slate-500">
            {isSignup
              ? "Set up your account to get started."
              : "Welcome back. Enter your credentials."}
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
                {!isSignup && (
                  <Link href="/forgot" className="text-xs font-medium text-brand hover:underline">
                    Forgot password?
                  </Link>
                )}
              </div>
              <PasswordInput id="password" name="password" placeholder="••••••••" required minLength={6} />
            </div>

            <Button
              type="submit"
              className="w-full"
              size="lg"
              formAction={isSignup ? signup : login}
            >
              {isSignup ? "Create account" : "Sign in"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            {isSignup ? (
              <>
                Already have an account?{" "}
                <Link href="/login" className="font-medium text-brand hover:underline">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                Need an account?{" "}
                <Link href="/login?mode=signup" className="font-medium text-brand hover:underline">
                  Sign up
                </Link>
              </>
            )}
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-white/60">
          Service · Integrity · Reliability
        </p>
      </div>
    </div>
  );
}
