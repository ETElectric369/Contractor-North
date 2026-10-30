import { fillText, translator } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";
import type { UsageState } from "@/lib/usage-window";

/**
 * THE USAGE RING (cn-v1140) — the one meter, like the Claude usage window: a track, a fill that
 * follows the percent, and the percent inside it as the one number. Its color follows the warnings
 * (lib/usage-window states): the app's accent while fine, amber at watch, orange at almost, red at
 * out. Server-safe (no hooks, no client directive), so a server page and a client card draw the
 * same ring. No dollar, no count, no unit — a percent and a color, nothing to explain.
 *
 * Accessible as a meter: role="meter" with min 0, max 100, now the percent, and a label from the
 * catalog in the person's language. The only motion is the fill easing to its new offset, and only
 * for people who have not asked for reduced motion.
 *
 * A DEGRADED meter (lib/usage-meter: a read that failed, the open answer) draws "—" inside an empty
 * track instead of a confident "0%", and carries no aria-valuenow: a number nobody read is not a
 * number. The label is the headline alone.
 */
export type UsageRingProps = {
  /** 0–100 (clamped). */
  pct: number;
  state: UsageState;
  /** The meter could not be read: "—" inside, no value. */
  degraded?: boolean;
  lang?: Lang;
  /** Pixels, square. */
  size?: number;
  className?: string;
};

/** The fill's stroke by state — the app's sea-glass accent (globals.css --glass-tint) while fine. */
const STROKE: Record<UsageState, string> = {
  fine: "stroke-[rgb(var(--glass-tint))] dark:stroke-teal-400",
  watch: "stroke-amber-500 dark:stroke-amber-400",
  almost: "stroke-orange-500 dark:stroke-orange-400",
  out: "stroke-red-600 dark:stroke-red-500",
};

/** The percent's ink by state, so a glance at the number says the same thing as the ring. */
const INK: Record<UsageState, string> = {
  fine: "text-slate-900 dark:text-slate-100",
  watch: "text-amber-700 dark:text-amber-300",
  almost: "text-orange-700 dark:text-orange-300",
  out: "text-red-700 dark:text-red-300",
};

const RADIUS = 44;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function UsageRing({ pct, state, degraded = false, lang = "en", size = 96, className }: UsageRingProps) {
  const t = translator(lang);
  const p = degraded ? 0 : Math.min(100, Math.max(0, Math.round(Number.isFinite(pct) ? pct : 0)));
  const offset = CIRCUMFERENCE * (1 - p / 100);
  return (
    <svg
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(degraded ? {} : { "aria-valuenow": p })}
      aria-label={degraded ? t("us_usage") : fillText(t("us_ringAria"), { pct: String(p) })}
      data-degraded={degraded || undefined}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      data-state={state}
      className={["shrink-0", className].filter(Boolean).join(" ")}
    >
      <circle cx="50" cy="50" r={RADIUS} fill="none" strokeWidth="8" className="stroke-slate-200 dark:stroke-slate-700" />
      <circle
        cx="50"
        cy="50"
        r={RADIUS}
        fill="none"
        strokeWidth="8"
        strokeLinecap={p > 0 ? "round" : "butt"}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        transform="rotate(-90 50 50)"
        className={`${STROKE[state]} motion-safe:transition-[stroke-dashoffset] motion-safe:duration-500`}
      />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central" className={`fill-current text-[22px] font-bold tabular-nums ${INK[state]}`}>
        {degraded ? "—" : `${p}%`}
      </text>
    </svg>
  );
}
