import Link from "next/link";
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
            Enter your email and we'll send you a link to set a new password.
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

          <form action={requestPasswordReset} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" placeholder="you@company.com" required />
            </div>
            <Button type="submit" size="lg" className="w-full">
              Send reset link
            </Button>
          </form>

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
