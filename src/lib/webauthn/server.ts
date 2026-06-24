import { headers } from "next/headers";

/** The WebAuthn relying-party config, derived from the request so it works on localhost
 *  AND prod without a hardcoded domain. rpID = the bare host (passkeys bind to it);
 *  origin = the full scheme+host the browser will assert. */
export async function getRpConfig(): Promise<{ rpID: string; rpName: string; origin: string }> {
  // Prefer a pinned, host-independent config in prod (set WEBAUTHN_RP_ID + WEBAUTHN_ORIGIN
  // to the real address bar users see) so a spoofed Host header can't shift the RP. Fall
  // back to deriving from the request only when unset (dev / preview).
  const envId = process.env.WEBAUTHN_RP_ID;
  const envOrigin = process.env.WEBAUTHN_ORIGIN;
  if (envId && envOrigin) return { rpID: envId, rpName: "Contractor North", origin: envOrigin };

  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return { rpID: host.split(":")[0], rpName: "Contractor North", origin: `${proto}://${host}` };
}

export function bytesToB64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}
export function b64urlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** Stable per-action binding so a step-up assertion can't be replayed for a different
 *  action/input. Hash of the action name + a canonical JSON of the input. */
export async function actionHash(name: string, input: unknown): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(name + "|" + stableStringify(input)).digest("base64url");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
}
