import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";
import { blockedAddress, blockedHostname, parseIPv4 } from "./address-guard";

/**
 * READ ONE PUBLIC WEB PAGE, SAFELY (Fill From Their Site, 2026-09-27).
 *
 * The address comes from a person's paste, so this is written as if it came from an attacker:
 *   - http and https only; no login in the address; ports 80, 443, 8080 and 8443 only.
 *   - Every host is resolved first, and refused when ANY address it resolves to is private,
 *     loopback, link-local (169.254.169.254), CGNAT or otherwise not public (address-guard.ts).
 *   - The connection is PINNED to the address that passed: http.request is handed a lookup that
 *     returns it, so a second DNS answer (rebinding) can't slip a private address in after the check.
 *   - Redirects are followed by hand, at most 3, and each new address goes through all of the above.
 *   - Nothing of the person's is sent: no cookies, no credentials, a plain User-Agent.
 *   - 8 seconds for the whole read, redirects included; at most 1.5 MB of page is read (anything past
 *     that is cut off, never downloaded); only an HTML page is read at all.
 *
 * What comes back is DATA. Whoever reads it (extract.ts, the model in ai-read.ts) treats it that way.
 */

export const READ_LIMITS = { timeoutMs: 8_000, maxBytes: 1_500_000, maxRedirects: 3 };

/** Plain and honest: who is asking, and where to find out more. Never a browser disguise. */
export const USER_AGENT = "Mozilla/5.0 (compatible; ContractorNorth/1.0; +https://contractornorth.com)";

const REQUEST_HEADERS: Record<string, string> = {
  "user-agent": USER_AGENT,
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  "accept-language": "en-US,en;q=0.8",
  "accept-encoding": "gzip, deflate, br",
};

const PORTS = new Set(["", "80", "443", "8080", "8443"]);

export type ReadFailure =
  | "bad-url"
  | "not-web"
  | "has-login"
  | "port"
  | "private"
  | "no-such-site"
  | "timeout"
  | "too-many-redirects"
  | "http-error"
  | "not-html"
  | "unreachable";

export type PageRead =
  | { ok: true; html: string; finalUrl: string; truncated: boolean }
  | { ok: false; why: ReadFailure; status?: number };

export type Resolved = { address: string; family: number };

/** One request to one checked address. `get` must NOT follow redirects or resolve the host again. */
export interface Hop {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
}
export interface HopResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  cancel: () => void;
}
export interface ReadDeps {
  lookup?: (hostname: string) => Promise<Resolved[]>;
  get?: (hop: Hop) => Promise<HopResponse>;
  limits?: Partial<typeof READ_LIMITS>;
}

/** Why this URL may not be fetched, before any DNS: scheme, login, port, and names that only mean "inside". */
export function refuseUrl(url: URL): ReadFailure | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "not-web";
  if (url.username || url.password) return "has-login";
  if (blockedHostname(url.hostname)) return "private";
  if (!PORTS.has(url.port)) return "port";
  return null;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

/** The host's one checked address, or why there isn't one. Every address DNS gives back must be
 *  public: a name that answers with a public AND a private address is refused, not half-trusted. */
async function checkedAddress(
  hostname: string,
  lookup: (h: string) => Promise<Resolved[]>,
  signal: AbortSignal,
): Promise<{ address: string; family: 4 | 6 } | { why: ReadFailure }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (parseIPv4(host) !== null) return blockedAddress(host) ? { why: "private" } : { address: host, family: 4 };
  if (hostname.startsWith("[")) return blockedAddress(host) ? { why: "private" } : { address: host, family: 6 };
  let found: Resolved[];
  try {
    found = await Promise.race([lookup(host), rejectOnAbort(signal)]);
  } catch {
    return { why: signal.aborted ? "timeout" : "no-such-site" };
  }
  if (!found?.length) return { why: "no-such-site" };
  if (found.some((r) => blockedAddress(r.address))) return { why: "private" };
  const first = found[0];
  return { address: first.address, family: first.family === 6 || first.address.includes(":") ? 6 : 4 };
}

function charsetOf(contentType: string | undefined, head: Uint8Array): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) return fromHeader;
  const peek = Buffer.from(head.subarray(0, 2048)).toString("latin1");
  return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(peek)?.[1] ?? "utf-8";
}

function decode(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function isHtmlType(contentType: string): boolean {
  const t = contentType.split(";")[0].trim().toLowerCase();
  return t === "text/html" || t === "application/xhtml+xml";
}

/** Read at most `max` bytes. Past that the rest is never pulled: the stream is cancelled. */
async function readCapped(res: HopResponse, max: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of res.body) {
      if (signal.aborted) throw new Error("aborted");
      const room = max - total;
      if (chunk.byteLength > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        total += Math.max(0, room);
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    res.cancel();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { bytes: out, truncated };
}

/** The one door. Never throws: every failure comes back as a reason the caller can say in words. */
export async function readPublicPage(raw: string, deps: ReadDeps = {}): Promise<PageRead> {
  const limits = { ...READ_LIMITS, ...(deps.limits ?? {}) };
  const lookup = deps.lookup ?? systemLookup;
  const get = deps.get ?? pinnedGet;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, why: "bad-url" };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), limits.timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      url.hash = "";
      const refused = refuseUrl(url);
      if (refused) return { ok: false, why: refused };
      const where = await checkedAddress(url.hostname, lookup, ac.signal);
      if ("why" in where) return { ok: false, why: where.why };
      const res = await Promise.race([
        get({ url, address: where.address, family: where.family, headers: { ...REQUEST_HEADERS }, signal: ac.signal }),
        rejectOnAbort(ac.signal),
      ]);
      if (res.status >= 300 && res.status < 400) {
        res.cancel();
        const location = res.headers["location"];
        if (!location) return { ok: false, why: "http-error", status: res.status };
        if (hop >= limits.maxRedirects) return { ok: false, why: "too-many-redirects" };
        try {
          url = new URL(location, url);
        } catch {
          return { ok: false, why: "bad-url" };
        }
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.cancel();
        return { ok: false, why: "http-error", status: res.status };
      }
      const type = res.headers["content-type"];
      if (type && !isHtmlType(type)) {
        res.cancel();
        return { ok: false, why: "not-html" };
      }
      const { bytes, truncated } = await readCapped(res, limits.maxBytes, ac.signal);
      const html = decode(bytes, charsetOf(type, bytes));
      // No content type at all: read it only if it plainly is HTML.
      if (!type && !/<(!doctype\s+html|html|head|body)\b/i.test(html.slice(0, 2048))) return { ok: false, why: "not-html" };
      return { ok: true, html, finalUrl: url.toString(), truncated };
    }
  } catch {
    return { ok: false, why: ac.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function systemLookup(hostname: string): Promise<Resolved[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * THE REAL REQUEST, pinned to the checked address. Node asks `lookup` for the host's address and
 * gets back only the one that passed; with Happy Eyeballs on it asks for `all`, and gets that one
 * in a list. A fresh agent per request, so no pooled socket to another host is ever reused. TLS is
 * still verified against the host NAME. Redirects are not followed here (readPublicPage does it).
 */
export function pinnedGet(hop: Hop): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const mod = hop.url.protocol === "https:" ? https : http;
    const pinned = (_host: string, opts: { all?: boolean } | number | undefined, cb: LookupCb) => {
      if (typeof opts === "object" && opts?.all) cb(null, [{ address: hop.address, family: hop.family }]);
      else cb(null, hop.address, hop.family);
    };
    const req = mod.request(
      hop.url,
      { method: "GET", headers: hop.headers, signal: hop.signal, agent: false, lookup: pinned as never },
      (res) => {
        const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
        let body: Readable = res;
        if (enc === "gzip" || enc === "x-gzip" || enc === "deflate") body = pipeline(res, zlib.createUnzip(), () => {});
        else if (enc === "br") body = pipeline(res, zlib.createBrotliDecompress(), () => {});
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body,
          cancel: () => {
            body.destroy();
            res.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
