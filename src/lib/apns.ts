import "server-only";
import http2 from "node:http2";
import { createSign } from "node:crypto";
import { reportError } from "@/lib/observe";

/**
 * APPLE PUSH, FOR THE NATIVE SHELL (2026-09-09).
 *
 * Web Push cannot reach the App Store app — it needs a service worker, and Apple's Web Push is
 * Safari / home-screen only, never a WKWebView. So the shell registers for APNs through
 * @capacitor/push-notifications and its device token lands in push_subscriptions (0250); this
 * module is the other half.
 *
 * Deliberately dependency-free. APNs speaks HTTP/2 ONLY — `fetch` is HTTP/1.1 and Apple simply
 * refuses it — so this uses node:http2 directly rather than pulling in a push library whose whole
 * job is the twelve lines of JWT below.
 *
 * CONFIG (Vercel env; the .p8 is a SIGNING KEY and lives nowhere in this repo):
 *   APNS_KEY_ID    the 10-character Key ID shown when the key was created
 *   APNS_TEAM_ID   the Apple Developer team (VZBM9D6U78)
 *   APNS_KEY_P8    the contents of AuthKey_<id>.p8, BEGIN/END lines included
 *   APNS_BUNDLE_ID optional; defaults to the shell's bundle id
 */

const KEY_ID = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
const KEY_P8 = process.env.APNS_KEY_P8;
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.contractornorth.app";

export const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;
export type ApnsEnv = keyof typeof APNS_HOSTS;

export function apnsConfigured(): boolean {
  return !!(KEY_ID && TEAM_ID && KEY_P8);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Apple's provider token. Signed ES256 over {alg,kid}.{iss,iat} — no body, no audience.
 *
 * CACHED ON PURPOSE: Apple rejects a token older than one hour (ExpiredProviderToken) AND
 * rejects a provider that mints them more often than once every 20 minutes
 * (TooManyProviderTokenUpdates). Refreshing every 50 minutes sits safely between the two.
 * Serverless means this cache lives only as long as the warm instance, which is fine — a cold
 * start mints one token, well inside the rate limit.
 */
let cached: { jwt: string; madeAt: number } | null = null;
const JWT_TTL_MS = 50 * 60 * 1000;

function providerToken(): string {
  const now = Date.now();
  if (cached && now - cached.madeAt < JWT_TTL_MS) return cached.jwt;
  const header = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID }));
  const claims = b64url(JSON.stringify({ iss: TEAM_ID, iat: Math.floor(now / 1000) }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  // The .p8 is a PKCS#8 EC private key. dsaEncoding 'ieee-p1363' is what makes this an ES256
  // JWS signature (r‖s) rather than the DER sequence Node emits by default — Apple rejects DER
  // with a bare 403 InvalidProviderToken and no hint as to why.
  const sig = signer.sign({ key: KEY_P8!, dsaEncoding: "ieee-p1363" });
  const jwt = `${header}.${claims}.${b64url(sig)}`;
  cached = { jwt, madeAt: now };
  return jwt;
}

export type ApnsResult =
  | { ok: true; env: ApnsEnv }
  /** The token is dead — a reinstall, a restore, or the app was deleted. Prune the row. */
  | { ok: false; gone: true; reason: string }
  /** Everything else: a transient failure, a config problem. Keep the row, log it. */
  | { ok: false; gone: false; reason: string };

/** One request to one host. Resolves; never throws. */
function post(host: string, token: string, payload: unknown): Promise<{ status: number; reason: string }> {
  return new Promise((resolve) => {
    let client: http2.ClientHttp2Session;
    try {
      client = http2.connect(host);
    } catch (e) {
      resolve({ status: 0, reason: String(e) });
      return;
    }
    const done = (r: { status: number; reason: string }) => {
      try {
        client.close();
      } catch {
        /* already closing */
      }
      resolve(r);
    };
    // A hung connection must not hold a serverless invocation open. Ten seconds is generous for
    // APNs, which normally answers in tens of milliseconds.
    const timer = setTimeout(() => done({ status: 0, reason: "timeout" }), 10_000);
    client.on("error", (e) => {
      clearTimeout(timer);
      done({ status: 0, reason: String(e) });
    });
    const body = Buffer.from(JSON.stringify(payload));
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": "alert",
      // 10 = deliver immediately. These are people-facing alerts, not background refreshes.
      "apns-priority": "10",
      authorization: `bearer ${providerToken()}`,
      "content-type": "application/json",
      "content-length": body.length,
    });
    let status = 0;
    let text = "";
    req.on("response", (h) => {
      status = Number(h[":status"]) || 0;
    });
    req.setEncoding("utf8");
    req.on("data", (c) => {
      text += c;
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      done({ status: 0, reason: String(e) });
    });
    req.on("end", () => {
      clearTimeout(timer);
      let reason = text;
      try {
        reason = (JSON.parse(text) as { reason?: string }).reason ?? text;
      } catch {
        /* APNs returns an empty body on success */
      }
      done({ status, reason });
    });
    req.end(body);
  });
}

/** A token Apple says will never be valid again — the row should go. */
const DEAD = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "TopicDisallowed"]);

/**
 * Send one alert to one device.
 *
 * `knownEnv` is the host that worked last time, stored on the row. When it's unknown we try
 * production first and fall back to sandbox once: a token minted by a debug build is invalid on
 * the production host and vice versa, and there is no way to tell them apart by looking. The
 * caller persists the winning env so this costs one extra round trip per device, ever.
 */
export async function sendApns(
  deviceToken: string,
  payload: { title: string; body: string; url?: string },
  knownEnv?: ApnsEnv | null,
): Promise<ApnsResult> {
  if (!apnsConfigured()) return { ok: false, gone: false, reason: "not configured" };
  const aps = {
    aps: { alert: { title: payload.title, body: payload.body }, sound: "default" },
    // Read by the tap handler in the shell so a notification opens the thing it is about.
    url: payload.url ?? "/planner",
  };
  const order: ApnsEnv[] = knownEnv ? [knownEnv] : ["production", "sandbox"];
  let last = { status: 0, reason: "no attempt" };
  for (const env of order) {
    const r = await post(APNS_HOSTS[env], deviceToken, aps);
    if (r.status === 200) return { ok: true, env };
    last = r;
    // Only a wrong-environment token is worth trying the other host for; a genuinely dead token
    // says BadDeviceToken on BOTH, which is why the loop ends with `gone` either way.
    if (r.reason !== "BadDeviceToken") break;
  }
  if (DEAD.has(last.reason)) return { ok: false, gone: true, reason: last.reason };
  if (last.status >= 500 || last.status === 0) return { ok: false, gone: false, reason: last.reason };
  // 400/403 that isn't a dead token is a CONFIG fault (bad key, wrong team, wrong topic) and will
  // fail for every device — surface it instead of letting the whole crew silently go quiet.
  reportError("apns", new Error(`APNs ${last.status}: ${last.reason}`));
  return { ok: false, gone: false, reason: last.reason };
}
