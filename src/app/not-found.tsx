import Link from "next/link";
import { Button } from "@/components/ui/button";

// THE APP'S MARK ON EVERY HOST (cn-v1203, 2026-11-26): the owner chose the mark everywhere, a company's own domain included.
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon-192.png" alt="Contractor North" className="mb-4 h-16 w-16 rounded-2xl shadow-sm" />
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
