import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashSecret } from "./code";

/**
 * Who may see a portal page (0331), with the database stubbed: which cookie is asked about which
 * kind of session, and what an ended office look turns into. The database's own answers are proven
 * in portal-code.integration.test.
 */
const rpc = vi.fn();
const reportError = vi.fn();
let jar: Record<string, string> = {};
/** customer_portal_access by token, with its company embedded (the switch board, 0352). null = no row. */
let portalRow: { organizations: { name: string; settings: unknown } | null } | null = null;
let portalRowError: { code: string; message: string } | null = null;
const from = vi.fn((table: string) => {
  const b: any = {
    select: () => b,
    eq: () => b,
    maybeSingle: async () => (table === "customer_portal_access" ? { data: portalRow, error: portalRowError } : { data: null, error: null }),
  };
  return b;
});

vi.mock("server-only", () => ({}));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ rpc, from }) }));
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

const { readPortalAccess } = await import("./access");

const TOKEN = "d".repeat(32);
const OFFICE = "e".repeat(64);
const CUSTOMER = "f".repeat(64);
const GATE = { data: { org: { name: "ET Electric" }, email: "mcpowder@comcast.net", live_code_sent_at: null }, error: null };
/** portal_session_check answers by which session hash it is asked about. */
const sessions = (live: Record<string, "customer" | "office">) =>
  rpc.mockImplementation(async (fn: string, args: { p_session_hash?: string }) => {
    if (fn === "portal_session_check") {
      const hit = Object.entries(live).find(([secret]) => hashSecret(secret) === args.p_session_hash);
      return { data: hit ? { kind: hit[1] } : null, error: null };
    }
    if (fn === "portal_gate") return GATE;
    throw new Error(`unexpected ${fn}`);
  });

beforeEach(() => {
  rpc.mockReset();
  reportError.mockReset();
  from.mockClear();
  jar = {};
  portalRow = null;
  portalRowError = null;
});

describe("readPortalAccess", () => {
  it("a live office look is in, as the office", async () => {
    jar = { cn_portal_office: OFFICE };
    sessions({ [OFFICE]: "office" });
    expect(await readPortalAccess(TOKEN)).toEqual({ kind: "in", session: "office" });
  });

  it("an ended office look is a notice, never the sign-in screen whose Send My Code emails the customer", async () => {
    jar = { cn_portal_office: OFFICE };
    sessions({});
    expect(await readPortalAccess(TOKEN)).toEqual({ kind: "office_ended", orgName: "ET Electric" });
  });

  it("an ended office look beside a live customer sign-in (the same browser) is the customer's page", async () => {
    jar = { cn_portal_office: OFFICE, cn_portal: CUSTOMER };
    sessions({ [CUSTOMER]: "customer" });
    expect(await readPortalAccess(TOKEN)).toEqual({ kind: "in", session: "customer" });
  });

  it("each cookie only opens its own kind: an office session in the customer's cookie opens nothing", async () => {
    jar = { cn_portal: OFFICE };
    sessions({ [OFFICE]: "office" });
    expect(await readPortalAccess(TOKEN)).toMatchObject({ kind: "gate" });
  });

  it("the sign-in screen: masked address, and how long ago a live code went", async () => {
    sessions({});
    rpc.mockImplementation(async (fn: string) =>
      fn === "portal_gate"
        ? { data: { ...GATE.data, live_code_sent_at: new Date(Date.now() - 4.5 * 60_000).toISOString() }, error: null }
        : { data: null, error: null },
    );
    const a = await readPortalAccess(TOKEN);
    expect(a).toMatchObject({ kind: "gate", maskedEmail: "m*******@comcast.net", codeSentMinutesAgo: 4 });
    expect(JSON.stringify(a)).not.toContain("mcpowder");
  });

  it("no code out: codeSentMinutesAgo is null", async () => {
    sessions({});
    expect(await readPortalAccess(TOKEN)).toMatchObject({ kind: "gate", codeSentMinutesAgo: null });
  });
});

describe("the Customer Portal switch (0352, rule f)", () => {
  it("off: 'portal_off' before any session is honoured, so a signed-in device is out too", async () => {
    jar = { cn_portal: CUSTOMER, cn_portal_office: OFFICE };
    sessions({ [CUSTOMER]: "customer", [OFFICE]: "office" });
    portalRow = { organizations: { name: "Fixture Electric", settings: { features: { customer_portal: false } } } };
    expect(await readPortalAccess(TOKEN)).toEqual({ kind: "portal_off", orgName: "Fixture Electric" });
    // Nothing else was asked: no session check, no gate, no code state.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("on (stored), or no switches stored: exactly today's answers", async () => {
    jar = { cn_portal: CUSTOMER };
    sessions({ [CUSTOMER]: "customer" });
    portalRow = { organizations: { name: "Fixture Electric", settings: { features: { customer_portal: true } } } };
    expect(await readPortalAccess(TOKEN)).toEqual({ kind: "in", session: "customer" });
    portalRow = { organizations: { name: "Fixture Electric", settings: {} } };
    expect(await readPortalAccess(TOKEN)).toEqual({ kind: "in", session: "customer" });
    jar = {};
    expect(await readPortalAccess(TOKEN)).toMatchObject({ kind: "gate" });
  });

  it("another switch off (Website, Panel Map) never shuts the portal", async () => {
    sessions({});
    portalRow = { organizations: { name: "Fixture Electric", settings: { features: { website: false, panel_map: false } } } };
    expect(await readPortalAccess(TOKEN)).toMatchObject({ kind: "gate" });
  });

  it("no link row (a retired link): the portal's own gate answers, as before", async () => {
    sessions({});
    rpc.mockImplementation(async (fn: string) => (fn === "portal_gate" ? { data: { disabled: true, org: { name: "Fixture Electric" } }, error: null } : { data: null, error: null }));
    expect(await readPortalAccess(TOKEN)).toEqual({ kind: "off", orgName: "Fixture Electric" });
  });

  it("the switch read failing never shuts a customer out: reported, then today's answer", async () => {
    sessions({});
    portalRowError = { code: "57014", message: "canceling statement due to statement timeout" };
    expect(await readPortalAccess(TOKEN)).toMatchObject({ kind: "gate" });
    expect(reportError).toHaveBeenCalledWith("portal.switches", portalRowError);
  });
});
