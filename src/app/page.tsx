import Link from "next/link";
import {
  Zap,
  Sparkles,
  Users,
  CalendarDays,
  Clock,
  ShoppingCart,
  Receipt,
  ArrowRight,
  Check,
  Bot,
  TrendingUp,
  Globe,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const TRADES = "Electricians · Deck builders · Remodelers · Plumbers · HVAC · GCs — every trade";

async function getSignedIn(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return Boolean(user);
  } catch {
    // Supabase env not configured (e.g. local dev) — still show the homepage.
    return false;
  }
}

const FEATURES = [
  { icon: Bot, title: "Nort, your AI assistant", desc: "Ask for anything — draft a quote, who's on the clock, this month's profit." },
  { icon: Sparkles, title: "AI estimating", desc: "Describe the work; get a priced, line-itemed quote in minutes." },
  { icon: Users, title: "CRM", desc: "Leads, customers, and every quote and job in one place." },
  { icon: CalendarDays, title: "Scheduling", desc: "Dispatch jobs and crews with a clear daily agenda." },
  { icon: Clock, title: "Timeclock + GPS", desc: "Clock in/out with location, lunch, job codes, and mileage." },
  { icon: ShoppingCart, title: "Materials & purchasing", desc: "Turn take-offs into purchase orders and receive them." },
  { icon: Receipt, title: "Billing & payments", desc: "Invoice from a quote, take card or ACH, track what's owed." },
  { icon: TrendingUp, title: "Job profitability", desc: "Budget vs. actual on every job — know your margin as you go." },
  { icon: Globe, title: "Your own website", desc: "A polished site with an instant-estimate button, hosted for you." },
];

export default async function Home() {
  const signedIn = await getSignedIn();

  return (
    <div className="min-h-screen bg-white">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white">
              <Zap className="h-5 w-5" />
            </div>
            <span className="text-base font-bold text-slate-900">Contractor North</span>
          </div>
          <div className="flex items-center gap-2">
            {signedIn ? (
              <Link href="/planner">
                <Button>
                  Open App <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <>
                <Link href="/login">
                  <Button variant="ghost">Sign In</Button>
                </Link>
                <Link href="/login?mode=signup">
                  <Button>Get Started</Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-brand to-brand-dark">
        <div className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-6 sm:py-28">
          <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-1.5 text-sm font-medium text-white backdrop-blur">
            <Sparkles className="h-4 w-4" /> One platform for the trades
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Run your entire contractor business from one place.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-white/85">
            Quotes, scheduling, timeclock, purchasing, and billing in one workflow —
            with an AI assistant that handles the busywork and your own website that
            brings in the leads.
          </p>
          <p className="mx-auto mt-4 max-w-2xl text-sm font-medium uppercase tracking-wider text-white/60">
            {TRADES}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href={signedIn ? "/planner" : "/login?mode=signup"}>
              <Button size="lg" className="bg-white text-brand hover:bg-slate-100">
                {signedIn ? "Open the App" : "Get Started Free"}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            {!signedIn && (
              <Link href="/login">
                <Button
                  size="lg"
                  variant="outline"
                  className="border-white/40 bg-transparent text-white hover:bg-white/10"
                >
                  Sign In
                </Button>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">
            Everything from the first call to the final payment
          </h2>
          <p className="mt-3 text-slate-500">
            One workflow: lead → quote → job → work order → timeclock → invoice.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md"
              >
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-light">
                  <Icon className="h-5 w-5 text-brand" />
                </div>
                <h3 className="text-base font-semibold text-slate-900">{f.title}</h3>
                <p className="mt-1.5 text-sm text-slate-500">{f.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* CTA band */}
      <section className="border-y border-slate-100 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-4 py-12 sm:flex-row sm:px-6">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">
              Ready to get organized?
            </h2>
            <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
              {["Quotes out the same day", "Know your margin on every job", "A website that brings in leads", "No more paper timecards"].map(
                (t) => (
                  <li key={t} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-brand" /> {t}
                  </li>
                ),
              )}
            </ul>
          </div>
          <Link href={signedIn ? "/planner" : "/login?mode=signup"}>
            <Button size="lg">
              {signedIn ? "Open the App" : "Create Your Account"}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col items-center justify-between gap-4 text-sm text-slate-400 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-white">
              <Zap className="h-4 w-4" />
            </div>
            <span className="font-semibold text-slate-600">Contractor North</span>
          </div>
          <span className="font-medium uppercase tracking-wider">
            Service · Integrity · Reliability
          </span>
        </div>
      </footer>
    </div>
  );
}
