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

vi.mock("server-only", () => ({}));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ rpc }) }));
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
  jar = {};
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
