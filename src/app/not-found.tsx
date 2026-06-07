import Link from "next/link";
import { Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-white">
        <Zap className="h-6 w-6" />
      </div>
      <h1 className="text-3xl font-bold text-slate-900">404</h1>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        We couldn't find that page.
      </p>
      <Link href="/dashboard" className="mt-5">
        <Button>Back to dashboard</Button>
      </Link>
    </div>
  );
}
