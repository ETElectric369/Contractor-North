import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { wireCalls } from "./stripe-wire.calls";

/**
 * WHAT THE APP PUTS ON THE WIRE TO STRIPE (cn-v1210).
 *
 * The Stripe SDK moved from 17.7 to 23.1 with the API version the app speaks left where it was. An
 * SDK is the thing that turns a call into a request, so an upgrade can change a request while no
 * line of the app changes and the type check stays green. One did: since SDK 22 a method that
 * takes an id reads its second argument as parameters and only its third as request options, and
 * the two deletes of a card-reader location passed the connected account second. The new SDK put
 * the account in the query string and sent no Stripe-Account header, so the delete was asked of
 * the wrong account, inside a catch that swallowed the answer.
 *
 * So the requests themselves are held here. tests/stripe-wire.recorded.json is what SDK 17.7 sent
 * for every call in tests/stripe-wire.calls.ts, recorded through its own HTTP client. Each call is
 * sent again through the INSTALLED SDK with a stand-in transport and must be the same request:
 * method, path, query, body in the order sent, the connected account, the idempotency key's kind.
 * A difference after an SDK upgrade is read and decided on purpose, and then recorded.
 *
 * WHAT THIS DOES NOT HOLD, said plainly. The table is a copy of the call sites, made by hand: a row
 * proves what the SDK does with a call of that shape, not that the call site still has that shape.
 * Three rules read the app's source for the ways a call site could drift from its row unnoticed: a
 * request option in the wrong place, an SDK method with no row, and which call sites name a
 * connected account. A parameter changed at a call site is not seen here; the call site's own
 * tests and the type check hold that. Also not held: the transport itself (the SDK's own HTTP
 * client against Stripe's servers) and what Stripe answers.
 */
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn() }));
import { STRIPE_API_VERSION } from "@/lib/stripe";

const ROOT = process.cwd();
type Sent = { method: string; path: string; query: string[]; body: string[]; account: string | null; idempotency: string };
type Recording = { recordedFrom: string; apiVersion: string; calls: (Sent & { name: string })[] };
const recorded = JSON.parse(readFileSync(join(ROOT, "tests/stripe-wire.recorded.json"), "utf8")) as Recording;

/** "a=1&b[c]=2" as the decoded pairs, in the order sent. */
function pairs(encoded: string): string[] {
  if (!encoded) return [];
  const plain = (x: string) => decodeURIComponent(x.replace(/\+/g, " "));
  return encoded.split("&").map((kv) => {
    const i = kv.indexOf("=");
    return i < 0 ? `${plain(kv)}=` : `${plain(kv.slice(0, i))}=${plain(kv.slice(i + 1))}`;
  });
}

/** The installed SDK, built as the app builds it, with a transport that records and answers 200. */
function recordingClient() {
  const sent: (Sent & { version: string | null; auth: string | null })[] = [];
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const key = headers.get("idempotency-key");
    sent.push({
      method: String(init?.method),
      path: url.pathname,
      query: pairs(url.search.replace(/^\?/, "")),
      body: pairs(typeof init?.body === "string" ? init.body : ""),
      account: headers.get("stripe-account"),
      idempotency: key == null ? "none" : /^stripe-node-retry-/.test(key) ? "automatic" : `ours: ${key}`,
      version: headers.get("stripe-version"),
      auth: headers.get("authorization"),
    });
    return new Response(JSON.stringify({ id: "obj_1", object: "thing", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": "req_1" },
    });
  };
  const client = new Stripe("placeholder-key-for-this-test", {
    apiVersion: STRIPE_API_VERSION as string as Stripe.LatestApiVersion,
    httpClient: Stripe.createFetchHttpClient(transport as typeof fetch),
  });
  return { client, sent };
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) && !/\.test-util\./.test(e.name)) out.push(rel);
  }
  return out;
}

/** A call of the SDK found in source text: its method as "a.b.c" and its arguments as written. */
type SdkCall = { method: string; args: string[] };

/**
 * Every SDK call in a source text: `getStripe().a.b.c(...)` or `stripe.a.b.c(...)`. The arguments
 * are split at the commas that sit outside every bracket, which is all the rules below need. A
 * call made through another name is not seen: the app has none today, and one would show as a
 * method with no row, or a count that moved, only if it were written one of these two ways.
 */
function sdkCalls(source: string): SdkCall[] {
  // Comments go first: a comma or a bracket inside one is not part of the call.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const found: SdkCall[] = [];
  for (const m of text.matchAll(/\b(?:getStripe\(\)|stripe)\s*\.\s*((?:[A-Za-z]+\s*\.\s*)+[A-Za-z]+)\s*\(/g)) {
    const args: string[] = [];
    let depth = 0;
    let from = m.index + m[0].length;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) {
        if (depth === 0) {
          if (text.slice(from, i).trim()) args.push(text.slice(from, i).trim());
          break;
        }
        depth--;
      } else if (ch === "," && depth === 0) {
        args.push(text.slice(from, i).trim());
        from = i + 1;
      }
    }
    found.push({ method: m[1].replace(/\s+/g, ""), args });
  }
  return found;
}

/**
 * WHERE A REQUEST OPTION MAY SIT. The SDK reads a call's arguments by place: a call that takes an
 * id reads (id, parameters, options), one that does not reads (parameters, options). An object in
 * an earlier place is parameters, whatever it holds, so an option named there never takes effect:
 * a connected account ends up in the query or the body and the call is made on the platform's own
 * account. That is the mistake that was found. Wrong here:
 *   - an object written in place that names a request option anywhere before its place;
 *   - a call that takes an id with exactly two arguments whose second is NOT written in place,
 *     because a variable cannot be read from here: write the parameters in place, or pass {} and
 *     the options third.
 */
const TAKES_AN_ID = /(?:^|\.)(?:retrieve|del|update|cancel|capture|confirm|createLoginLink)$/;
const REQUEST_OPTION = /\b(?:stripeAccount|idempotencyKey|timeout|maxNetworkRetries|apiVersion)\b/;
const writtenInPlace = (arg: string) => arg.startsWith("{");
function misplacedOptions(source: string): SdkCall[] {
  return sdkCalls(source).filter((c) => {
    const takesId = TAKES_AN_ID.test(c.method) && c.args.length > 0 && !writtenInPlace(c.args[0]);
    const optionsPlace = takesId ? 2 : 1;
    if (c.args.slice(0, optionsPlace).some((a) => writtenInPlace(a) && REQUEST_OPTION.test(a))) return true;
    return takesId && c.args.length === 2 && !writtenInPlace(c.args[1]);
  });
}

/**
 * WHICH CALL SITES ACT ON A CONNECTED ACCOUNT, written down: for each SDK method, how many call
 * sites in the app name `stripeAccount`, of how many. In a Connect app this is the fact that
 * decides whose money a call touches, and no other test held it for most of these call sites: the
 * table above is a copy of the call sites, so a call site that lost its account would still pass
 * every row. A number that moves here is read against the table before it is changed.
 */
const ON_A_CONNECTED_ACCOUNT: Record<string, [naming: number, sites: number]> = {
  "accountLinks.create": [0, 1],
  "accounts.create": [0, 1],
  "accounts.createLoginLink": [0, 1],
  "accounts.retrieve": [0, 1],
  "balance.retrieve": [0, 1],
  "billingPortal.sessions.create": [0, 1],
  "charges.retrieve": [1, 1],
  "checkout.sessions.create": [1, 3],
  "checkout.sessions.list": [0, 1],
  "customers.create": [0, 1],
  "paymentIntents.cancel": [1, 1],
  "paymentIntents.create": [1, 1],
  "paymentIntents.retrieve": [3, 3],
  "prices.retrieve": [0, 2],
  "subscriptions.retrieve": [0, 2],
  "terminal.connectionTokens.create": [1, 1],
  "terminal.locations.create": [1, 1],
  "terminal.locations.del": [2, 2],
  "webhooks.constructEvent": [0, 1],
};

/** A request option that ended up as a query or body pair. */
const LEAKED_OPTION = /^(?:stripeAccount|stripe_account|idempotencyKey|idempotency_key|maxNetworkRetries|timeout|apiVersion)(?:=|\[)/;

describe("what the app puts on the wire to Stripe", () => {
  it("the recording is of the API version the app names, and has one entry for each call in the table, in order", () => {
    expect(
      recorded.apiVersion,
      "The app's Stripe API version moved. Every request below was recorded on the old one: read Stripe's changelog between " +
        "the two, send the calls again on the new version, read each difference, then record them in tests/stripe-wire.recorded.json.",
    ).toBe(STRIPE_API_VERSION);
    expect(recorded.calls.map((c) => c.name)).toEqual(wireCalls.map((c) => c.name));
    expect(new Set(wireCalls.map((c) => c.name)).size).toBe(wireCalls.length);
  });

  it.each(wireCalls.map((c) => [c.name, c] as const))("%s: the installed SDK sends the request that was recorded", async (name, call) => {
    const { client, sent } = recordingClient();
    await call.run(client);
    expect(sent, "one call is one request").toHaveLength(1);
    const { version, auth, ...request } = sent[0];
    expect(version).toBe(STRIPE_API_VERSION);
    expect(auth).toBe("Bearer placeholder-key-for-this-test");
    // No request option may travel as data: that is what the wrong delete did.
    expect([...request.query, ...request.body].filter((pair) => LEAKED_OPTION.test(pair))).toEqual([]);
    const want = recorded.calls.find((c) => c.name === name);
    expect({ name, ...request }).toEqual(want);
  });

  it("the recording itself is sound: no request option was ever recorded as data, and the delete is the right request", () => {
    // This reads only the recording. It fails when a recording is made from a wrong call and saved
    // as it came, which is how the mistake would otherwise be written into the thing that guards it.
    for (const c of recorded.calls) expect([...c.query, ...c.body].filter((pair) => LEAKED_OPTION.test(pair)), c.name).toEqual([]);
    expect(recorded.calls.filter((c) => c.account !== null).length).toBeGreaterThanOrEqual(10);
    expect(recorded.calls.find((c) => c.name === "tap: delete a stray location")).toEqual({
      name: "tap: delete a stray location",
      method: "DELETE",
      path: "/v1/terminal/locations/tml_1",
      query: [],
      body: [],
      account: "acct_1",
      idempotency: "none",
    });
  });

  it("a request option in the wrong place is caught in source text, and no call site in the app has one", () => {
    const wrong = (code: string) => misplacedOptions(code).length;
    // The mistake as it was written, and its near neighbours.
    expect(wrong("await getStripe().terminal.locations.del(locationId, { stripeAccount: connect.accountId! });")).toBe(1);
    expect(wrong("stripe.paymentIntents.retrieve(id, { ...(a ? { stripeAccount: a } : {}), timeout: 8000 })")).toBe(1);
    expect(wrong("stripe.prices.retrieve(\n  id,\n  { timeout: 5000, maxNetworkRetries: 0 },\n)")).toBe(1);
    expect(wrong("getStripe().accounts.createLoginLink(org.stripe_account_id as string, { idempotencyKey: k })")).toBe(1);
    // The same mistake on a call with no id: the options as the only argument.
    expect(wrong('getStripe().terminal.connectionTokens.create({ stripeAccount: "acct_1" })')).toBe(1);
    expect(wrong("stripe.checkout.sessions.list({ payment_intent: pi, limit: 1, stripeAccount: a })")).toBe(1);
    // Options a variable holds cannot be read here, so the two-argument form must be written in place.
    expect(wrong("getStripe().terminal.locations.del(locationId, opts)")).toBe(1);
    expect(wrong("stripe.paymentIntents.cancel(id, tenant(accountId))")).toBe(1);
    // The right forms are left alone, with a comment and a comma between the arguments too.
    expect(wrong("await getStripe().terminal.locations.del(locationId, {}, { stripeAccount: connect.accountId! });")).toBe(0);
    expect(wrong("getStripe().terminal.locations.del(locationId, {}, opts)")).toBe(0);
    expect(wrong('stripe.prices.retrieve(priceId, { expand: ["product"] })')).toBe(0);
    expect(wrong("getStripe().balance.retrieve({}, { timeout: PROBE_TIMEOUT_MS, maxNetworkRetries: 0 })")).toBe(0);
    expect(wrong("getStripe().paymentIntents.create(\n  { amount },\n  // THE line that makes it a direct charge, not ours.\n  { stripeAccount: a },\n)")).toBe(0);
    expect(wrong('stripe.paymentIntents.retrieve(p.paymentIntent, { expand: ["latest_charge"] }, { ...(p.account ? { stripeAccount: p.account } : {}), timeout: 8000 })')).toBe(0);
    expect(wrong("getStripe().subscriptions.retrieve(\n  session.subscription as string,\n)")).toBe(0);
    const offenders = sourceFiles("src").filter((f) => misplacedOptions(readFileSync(join(ROOT, f), "utf8")).length > 0);
    expect(offenders).toEqual([]);
  });

  it("which call sites act on a connected account is written down, and the source agrees", () => {
    const counted: Record<string, [number, number]> = {};
    for (const f of sourceFiles("src")) {
      for (const c of sdkCalls(readFileSync(join(ROOT, f), "utf8"))) {
        const row = (counted[c.method] ??= [0, 0]);
        row[1]++;
        if (c.args.some((a) => /\bstripeAccount\b/.test(a))) row[0]++;
      }
    }
    expect(counted).toEqual(ON_A_CONNECTED_ACCOUNT);
    // And the table sends a row with the account for each method that has such a call site, and one without where the app has one without.
    for (const [method, [naming, sites]] of Object.entries(ON_A_CONNECTED_ACCOUNT)) {
      if (method === "webhooks.constructEvent") continue;
      const rows = recorded.calls.filter((c) => wireCalls.find((w) => w.name === c.name)?.method === method);
      if (naming > 0) expect(rows.some((r) => r.account !== null), `${method}: no row on a connected account`).toBe(true);
      if (naming < sites) expect(rows.some((r) => r.account === null), `${method}: no row on the platform's own account`).toBe(true);
    }
  });

  it("every SDK method the app's source calls has a call in the table, and the table calls nothing the app does not", () => {
    const inSource = new Set<string>();
    for (const f of sourceFiles("src")) for (const c of sdkCalls(readFileSync(join(ROOT, f), "utf8"))) inSource.add(c.method);
    // Verifying a webhook's signature sends nothing.
    inSource.delete("webhooks.constructEvent");
    expect(inSource.size, "the scan found no Stripe calls at all: the scan is broken, not the app").toBeGreaterThanOrEqual(15);
    expect([...new Set(wireCalls.map((c) => c.method))].sort()).toEqual([...inSource].sort());
  });

  it("each row of the table calls the method it names", () => {
    const table = readFileSync(join(ROOT, "tests/stripe-wire.calls.ts"), "utf8");
    // In the table the client is the arrow's parameter `s`: read `s.a.b.c(` as the scan reads `stripe.a.b.c(`.
    const called = sdkCalls(table.replace(/\bs\./g, "stripe.")).map((c) => c.method);
    expect(called).toEqual(wireCalls.map((c) => c.method));
  });

  it("the one parameter the later API refuses is only sent while the app names an earlier version", () => {
    // From the 2026-09-30 API on, payment_method_types on these two calls is answered with a 400.
    const sendsIt = ["src/app/api/pay/[token]/route.ts", "src/app/(app)/billing/tap-actions.ts"].filter((f) =>
      /\{\s*payment_method_types:/.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(sendsIt).toHaveLength(2);
    // What is passed past the SDK's types is this one parameter and nothing else: a cast to `object`
    // is unchecked, so a second field inside one, or a second such cast, would go unread.
    for (const f of ["src/app/api/pay/[token]/route.ts", "src/app/(app)/billing/tap-actions.ts"]) {
      const casts = readFileSync(join(ROOT, f), "utf8").match(/\.\.\.\(\{[^}]*\} as object\)/g) ?? [];
      expect(casts, f).toHaveLength(1);
      expect(casts[0], f).toMatch(/^\.\.\.\(\{ payment_method_types: \[[^\]]+\] \} as object\)$/);
    }
    expect(
      STRIPE_API_VERSION.slice(0, 10) < "2026-09-30",
      "The app now names a Stripe API version that refuses payment_method_types on a checkout session and on a payment: " +
        "rewrite both calls for that version before it ships (src/lib/stripe.ts says where).",
    ).toBe(true);
  });
});
