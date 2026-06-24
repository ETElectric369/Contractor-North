// A tiny in-memory ring buffer of the most recent console errors/warnings + uncaught
// errors, so the "Report a bug" button can attach what the console saw to each report.
// Installed once (idempotent) when the BugReporter mounts.

export type LogEntry = { level: string; msg: string; at: number };

const BUF: LogEntry[] = [];
const MAX = 20;
let installed = false;

function push(level: string, msg: string) {
  BUF.push({ level, msg: (msg || "").slice(0, 600), at: Date.now() });
  while (BUF.length > MAX) BUF.shift();
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export function installErrorCapture() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const origErr = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      push("error", fmt(args));
    } catch {}
    origErr(...(args as []));
  };
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    try {
      push("warn", fmt(args));
    } catch {}
    origWarn(...(args as []));
  };

  window.addEventListener("error", (e) => push("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener("unhandledrejection", (e) => push("error", `unhandledrejection: ${fmt([(e as PromiseRejectionEvent).reason])}`));
}

export function getLogs(): LogEntry[] {
  return BUF.slice();
}
