import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pinnedGet, readPublicPage, READ_LIMITS, USER_AGENT, type Hop, type HopResponse, type Resolved } from "./fetch-page";

/**
 * THE SSRF FENCE around Fill From Their Site. Nothing here touches the internet: DNS is a table and
 * every request is answered by a script (the `get` door), except the one pinning test at the bottom,
 * which talks to a server on this machine's own loopback to prove the connection goes to the address
 * that was checked and nowhere else.
 */

type Script = { status?: number; headers?: Record<string, string>; body?: string | Uint8Array[] | (() => AsyncIterable<Uint8Array>) };

function harness(dns: Record<string, string[]>, pages: Record<string, Script | ((hop: Hop) => Script)>) {
  const hops: Hop[] = [];
  const cancelled: string[] = [];
  const lookup = vi.fn(async (host: string): Promise<Resolved[]> => {
    const ips = dns[host];
    if (!ips) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  const get = vi.fn(async (hop: Hop): Promise<HopResponse> => {
    hops.push(hop);
    const entry = pages[hop.url.toString()];
    if (!entry) throw new Error(`unscripted ${hop.url}`);
    const s = typeof entry === "function" ? entry(hop) : entry;
    const b = s.body;
    const body =
      typeof b === "function"
        ? b()
        : (async function* () {
            if (typeof b === "string") yield new TextEncoder().encode(b);
            else for (const c of b ?? []) yield c;
          })();
    return { status: s.status ?? 200, headers: { "content-type": "text/html; charset=utf-8", ...(s.headers ?? {}) }, body, cancel: () => cancelled.push(hop.url.toString()) };
  });
  return { lookup, get, hops, cancelled };
}

const PAGE = "<!doctype html><html><head><title>Pine County Building</title></head><body>Hi</body></html>";

describe("readPublicPage: what it reads", () => {
  it("reads a public HTML page, pinned to the address DNS gave, with plain headers and no cookies", async () => {
    const h = harness({ "pinecounty.example.gov": ["93.184.216.34"] }, { "https://pinecounty.example.gov/building": { body: PAGE } });
    const r = await readPublicPage("https://pinecounty.example.gov/building", h);
    expect(r).toMatchObject({ ok: true, finalUrl: "https://pinecounty.example.gov/building", truncated: false });
    expect(r.ok && r.html).toContain("Pine County Building");
    expect(h.hops[0].address).toBe("93.184.216.34");
    expect(h.hops[0].headers["user-agent"]).toBe(USER_AGENT);
    expect(Object.keys(h.hops[0].headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    expect(Object.keys(h.hops[0].headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("follows up to 3 redirects, checking every new host", async () => {
    const h = harness(
      { "a.example.com": ["93.184.216.1"], "b.example.com": ["93.184.216.2"], "c.example.com": ["93.184.216.3"], "d.example.com": ["93.184.216.4"] },
      {
        "https://a.example.com/": { status: 301, headers: { location: "https://b.example.com/" } },
        "https://b.example.com/": { status: 302, headers: { location: "https://c.example.com/x" } },
        "https://c.example.com/x": { status: 307, headers: { location: "/y" } },
        "https://c.example.com/y": { body: PAGE },
      },
    );
    const r = await readPublicPage("https://a.example.com/", h);
    expect(r).toMatchObject({ ok: true, finalUrl: "https://c.example.com/y" });
    expect(h.lookup.mock.calls.map((c) => c[0])).toEqual(["a.example.com", "b.example.com", "c.example.com", "c.example.com"]);
  });

  it("decodes the page's own charset", async () => {
    const latin1 = Uint8Array.from([...Buffer.from("<html><body>Caf", "latin1"), 0xe9, ...Buffer.from("</body></html>", "latin1")]);
    const h = harness({ "x.example.com": ["93.184.216.34"] }, { "https://x.example.com/": { headers: { "content-type": "text/html; charset=iso-8859-1" }, body: [latin1] } });
    const r = await readPublicPage("https://x.example.com/", h);
    expect(r.ok && r.html).toContain("Café");
  });
});

describe("readPublicPage: SSRF refusals", () => {
  it.each([
    ["http://127.0.0.1/", "private"],
    ["http://[::1]/", "private"],
    ["http://169.254.169.254/latest/meta-data/", "private"],
    ["http://[fd00:ec2::254]/", "private"],
    ["http://10.1.2.3:8080/", "private"],
    ["http://2130706433/", "private"], // 127.0.0.1 written as one number
    ["http://0x7f.1/", "private"],
    ["http://localhost:3000/", "private"],
    ["http://metadata.google.internal/", "private"],
    ["file:///etc/passwd", "not-web"],
    ["ftp://example.com/", "not-web"],
    ["javascript:alert(1)", "not-web"],
    ["gopher://example.com/", "not-web"],
    ["https://user:pass@example.com/", "has-login"],
    ["https://example.com:22/", "port"],
    ["not a url", "bad-url"],
  ])("refuses %s (%s) without making a request", async (url, why) => {
    const h = harness({}, {});
    const r = await readPublicPage(url, h);
    expect(r).toEqual({ ok: false, why });
    expect(h.get).not.toHaveBeenCalled();
  });

  it("refuses a public name that resolves to a private address (DNS says 10.x)", async () => {
    const h = harness({ "sneaky.example.com": ["10.0.0.7"] }, {});
    expect(await readPublicPage("https://sneaky.example.com/", h)).toEqual({ ok: false, why: "private" });
    expect(h.get).not.toHaveBeenCalled();
  });

  it("refuses a name with ANY private answer, even alongside a public one", async () => {
    const h = harness({ "mixed.example.com": ["93.184.216.34", "127.0.0.1"] }, {});
    expect(await readPublicPage("https://mixed.example.com/", h)).toEqual({ ok: false, why: "private" });
    expect(h.get).not.toHaveBeenCalled();
  });

  it("refuses an IPv6 answer inside fc00::/7 or link-local", async () => {
    const h = harness({ "v6.example.com": ["fd12:3456::1"], "ll.example.com": ["fe80::1"] }, {});
    expect(await readPublicPage("https://v6.example.com/", h)).toEqual({ ok: false, why: "private" });
    expect(await readPublicPage("https://ll.example.com/", h)).toEqual({ ok: false, why: "private" });
  });

  it("refuses a redirect to the metadata address, re-checking the new host", async () => {
    const h = harness(
      { "public.example.com": ["93.184.216.34"] },
      { "https://public.example.com/": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } } },
    );
    expect(await readPublicPage("https://public.example.com/", h)).toEqual({ ok: false, why: "private" });
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.cancelled).toEqual(["https://public.example.com/"]);
  });

  it("refuses a redirect to a name that resolves privately (DNS rebinding through a redirect)", async () => {
    const h = harness(
      { "public.example.com": ["93.184.216.34"], "inside.example.com": ["192.168.0.10"] },
      { "https://public.example.com/": { status: 301, headers: { location: "https://inside.example.com/admin" } } },
    );
    expect(await readPublicPage("https://public.example.com/", h)).toEqual({ ok: false, why: "private" });
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to another scheme", async () => {
    const h = harness({ "public.example.com": ["93.184.216.34"] }, { "https://public.example.com/": { status: 302, headers: { location: "file:///etc/passwd" } } });
    expect(await readPublicPage("https://public.example.com/", h)).toEqual({ ok: false, why: "not-web" });
  });

  it("stops after 3 redirects", async () => {
    const pages: Record<string, Script> = {};
    for (let i = 0; i < 6; i++) pages[`https://loop.example.com/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    const h = harness({ "loop.example.com": ["93.184.216.34"] }, pages);
    expect(await readPublicPage("https://loop.example.com/0", h)).toEqual({ ok: false, why: "too-many-redirects" });
    expect(h.get).toHaveBeenCalledTimes(READ_LIMITS.maxRedirects + 1);
  });

  it("refuses anything but an HTML page, before reading its body", async () => {
    const h = harness(
      { "files.example.com": ["93.184.216.34"] },
      {
        "https://files.example.com/permit.pdf": { headers: { "content-type": "application/pdf" }, body: "%PDF-1.7" },
        "https://files.example.com/data.json": { headers: { "content-type": "application/json" }, body: "{}" },
      },
    );
    expect(await readPublicPage("https://files.example.com/permit.pdf", h)).toEqual({ ok: false, why: "not-html" });
    expect(await readPublicPage("https://files.example.com/data.json", h)).toEqual({ ok: false, why: "not-html" });
    expect(h.cancelled).toHaveLength(2);
  });

  it("never reads more than 1.5 MB: an endless page is cut off and the stream cancelled", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const h = harness(
      { "big.example.com": ["93.184.216.34"] },
      {
        "https://big.example.com/": {
          body: () =>
            (async function* () {
              yield new TextEncoder().encode("<html><body>");
              for (;;) {
                pulled += chunk.byteLength;
                yield chunk;
              }
            })(),
        },
      },
    );
    const r = await readPublicPage("https://big.example.com/", h);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.html)).toBeLessThanOrEqual(READ_LIMITS.maxBytes);
    }
    expect(pulled).toBeLessThanOrEqual(READ_LIMITS.maxBytes + chunk.byteLength);
    expect(h.cancelled).toEqual(["https://big.example.com/"]);
  });

  it("says timeout when the site doesn't answer in time", async () => {
    const h = harness({ "slow.example.com": ["93.184.216.34"] }, {});
    h.get.mockImplementation(() => new Promise(() => {}));
    expect(await readPublicPage("https://slow.example.com/", { ...h, limits: { timeoutMs: 30 } })).toEqual({ ok: false, why: "timeout" });
  });

  it("says so when the site doesn't exist or answers with an error", async () => {
    const h = harness({ "gone.example.com": ["93.184.216.34"] }, { "https://gone.example.com/": { status: 404, body: "no" } });
    expect(await readPublicPage("https://nowhere.example.com/", h)).toEqual({ ok: false, why: "no-such-site" });
    expect(await readPublicPage("https://gone.example.com/", h)).toEqual({ ok: false, why: "http-error", status: 404 });
  });
});

describe("pinnedGet: the connection goes to the checked address, not wherever DNS says now", () => {
  let server: http.Server;
  let port = 0;
  const seen: { host?: string; cookie?: string; ua?: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, cookie: req.headers.cookie, ua: req.headers["user-agent"] });
      if (req.url === "/moved") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>pinned</body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function text(res: HopResponse) {
    let s = "";
    for await (const c of res.body) s += Buffer.from(c).toString();
    return s;
  }

  it("connects to the pinned address under a name no DNS knows, sending the plain headers only", async () => {
    // "pinned.invalid" can't resolve anywhere; the request still lands, so no second lookup ran.
    const res = await pinnedGet({
      url: new URL(`http://pinned.invalid:${port}/`),
      address: "127.0.0.1",
      family: 4,
      headers: { "user-agent": USER_AGENT },
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(200);
    expect(await text(res)).toContain("pinned");
    expect(seen.at(-1)).toEqual({ host: `pinned.invalid:${port}`, cookie: undefined, ua: USER_AGENT });
  });

  it("does not follow a redirect by itself", async () => {
    const res = await pinnedGet({
      url: new URL(`http://pinned.invalid:${port}/moved`),
      address: "127.0.0.1",
      family: 4,
      headers: { "user-agent": USER_AGENT },
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://169.254.169.254/");
    res.cancel();
  });

  it("and the full reader refuses that same loopback server outright", async () => {
    const r = await readPublicPage(`http://pinned.example.com:8080/`, { lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    expect(r).toEqual({ ok: false, why: "private" });
  });
});
