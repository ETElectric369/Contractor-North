export const metadata = { title: "Offline · Contractor North" };

export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-50 p-8 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon-192.png" alt="Contractor North" className="h-16 w-16 rounded-2xl" />
      <h1 className="text-xl font-bold text-slate-900">You&apos;re offline</h1>
      <p className="max-w-xs text-sm text-slate-500">
        No internet connection right now. Reconnect and tap below — pages you&apos;ve already opened
        may still work.
      </p>
      <a
        href="/dashboard"
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Try again
      </a>
    </div>
  );
}
