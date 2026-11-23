import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE INVITE EMAIL CARRIES THE ONE-STEP LINK (cn-v1183): createInvitation reads the new row's token
 * back and builds the link with inviteJoinLink, the one builder the office's Copy Link calls too.
 * With no token back, or no service client for the join page to read the row with, the OLD sign-up
 * link is sent (it still works) and the sink hears it once, with no address and no token.
 */
const state = vi.hoisted(() => ({
  token: "ab".repeat(24) as string | null,
  adminOn: true,
  orgName: "Larkspur <Electric> & Sons",
  sent: [] as { to: string; subject: string; html: string }[],
  inserted: [] as Record<string, unknown>[],
  /** The invitations already on file (fixer #85, F3): the delete honours its filters over these. */
  rows: [] as Record<string, unknown>[],
  deleteFail: null as { message: string } | null,
  order: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (m: { to: string; subject: string; html: string }) => {
    state.sent.push(m);
    return { ok: true };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ adminConfigured: () => state.adminOn, createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
    from(table: string) {
      const filters: [string, string, unknown][] = [];
      let deleting = false;
      const chain: any = {
        select(cols?: string) {
          chain._cols = cols;
          return chain;
        },
        eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), chain),
        is: (c: string, v: unknown) => (filters.push(["is", c, v]), chain),
        gt: (c: string, v: unknown) => (filters.push(["gt", c, v]), chain),
        ilike: () => chain,
        delete() {
          deleting = true;
          return chain;
        },
        then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) {
          if (!deleting) return Promise.resolve({ data: null, error: null }).then(ok, err);
          state.order.push("delete");
          if (state.deleteFail) return Promise.resolve({ data: null, error: state.deleteFail }).then(ok, err);
          const hit = state.rows.filter((r) =>
            filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : op === "is" ? (r[c] ?? null) === v : String(r[c]) > String(v))),
          );
          state.rows = state.rows.filter((r) => !hit.includes(r));
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(ok, err);
        },
        insert(row: Record<string, unknown>) {
          state.order.push("insert");
          state.inserted.push(row);
          return chain;
        },
        single: async () => ({ data: { id: "inv-1", token: state.token, expires_at: "2026-12-06T12:00:00Z" }, error: null }),
        maybeSingle: async () => {
          if (table === "profiles" && chain._cols === "org_id, role, active") {
            return { data: { org_id: "org-larkspur", role: "owner", active: true }, error: null };
          }
          if (table === "organizations") return { data: { name: state.orgName }, error: null };
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };
  return { createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) };
});

import { createInvitation } from "./actions";
import { inviteJoinLink, inviteCopyLink, inviteSignupLink } from "@/lib/invite-door";
import { reportError } from "@/lib/observe";

const BASE = "https://app.example.com";
const form = (email: string, role: string) => {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("role", role);
  return fd;
};
let oldBase: string | undefined;

beforeEach(() => {
  oldBase = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = BASE;
  state.token = "ab".repeat(24);
  state.adminOn = true;
  state.orgName = "Larkspur <Electric> & Sons";
  state.sent = [];
  state.inserted = [];
  state.rows = [];
  state.deleteFail = null;
  state.order = [];
  vi.mocked(reportError).mockClear();
});
afterEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = oldBase;
});

describe("createInvitation", () => {
  it("the returned link and the email's button are inviteJoinLink(base, token); the role in words; the org escaped", async () => {
    const res = await createInvitation(form("Theo.Vance@example.com", "office"));
    const link = inviteJoinLink(BASE, state.token)!;
    expect(res).toEqual({ ok: true, link, emailed: true });
    expect(state.inserted[0]).toMatchObject({ email: "theo.vance@example.com", role: "office", org_id: "org-larkspur" });
    const mail = state.sent[0];
    expect(mail.to).toBe("theo.vance@example.com");
    expect(mail.subject).toBe("You're invited to join Larkspur <Electric> & Sons on Contractor North");
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.html).toContain("You've been invited to Larkspur &lt;Electric&gt; &amp; Sons");
    expect(mail.html).toContain("Larkspur &lt;Electric&gt; &amp; Sons added you on Contractor North as office staff. Tap the button, choose a password, and you're in. There is no second email to confirm.");
    expect(mail.html).toContain(">Join Larkspur &lt;Electric&gt; &amp; Sons</a>");
    expect(mail.html).toContain(`This link is yours: it works once, until Dec 6, 2026. Or open: ${link}`);
    expect(mail.html).not.toContain("<Electric>");
    expect(mail.html).not.toContain("mode=signup");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("each role reads as words", async () => {
    for (const [role, words] of [["tech", "as a tech."], ["admin", "as an admin."], ["office", "as office staff."], ["owner", "as a tech."]]) {
      state.sent = [];
      await createInvitation(form("dana.rook@example.com", role));
      expect(state.sent[0].html).toContain(words);
    }
  });

  it("no token back: the OLD link, today's words, and the sink hears it once with no address or token", async () => {
    state.token = null;
    const res = await createInvitation(form("dana.rook@example.com", "tech"));
    const old = `${BASE}/login?mode=signup&email=${encodeURIComponent("dana.rook@example.com")}`;
    expect(res).toEqual({ ok: true, link: old, emailed: true });
    expect(state.sent[0].html).toContain("Create your account with <strong>this email</strong>");
    expect(state.sent[0].html).toContain(">Create your account</a>");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0][0]).toBe("createInvitation.noToken");
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain("example.com");
  });

  it("one open invitation per company and address: this company's older OPEN row is replaced before the insert; expired, accepted and other rows are kept (fixer #85, F3)", async () => {
    state.rows = [
      { id: "old-open", org_id: "org-larkspur", email: "dana.rook@example.com", accepted_at: null, expires_at: "2099-01-01T00:00:00Z" },
      { id: "old-expired", org_id: "org-larkspur", email: "dana.rook@example.com", accepted_at: null, expires_at: "2020-01-01T00:00:00Z" },
      { id: "old-accepted", org_id: "org-larkspur", email: "dana.rook@example.com", accepted_at: "2026-11-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
      { id: "other-company", org_id: "org-northline", email: "dana.rook@example.com", accepted_at: null, expires_at: "2099-01-01T00:00:00Z" },
      { id: "other-address", org_id: "org-larkspur", email: "theo.vance@example.com", accepted_at: null, expires_at: "2099-01-01T00:00:00Z" },
    ];
    const res = await createInvitation(form("Dana.Rook@example.com", "admin"));
    expect(res.ok).toBe(true);
    expect(state.order).toEqual(["delete", "insert"]);
    expect(state.rows.map((r) => r.id)).toEqual(["old-expired", "old-accepted", "other-company", "other-address"]);
  });

  it("a failed replace refuses the invite in one sentence and writes nothing", async () => {
    state.deleteFail = { message: "permission denied" };
    const res = await createInvitation(form("dana.rook@example.com", "tech"));
    expect(res).toEqual({ ok: false, error: "That invite couldn't be sent: the older one for this address couldn't be replaced. Try again." });
    expect(state.inserted).toEqual([]);
    expect(state.sent).toEqual([]);
  });

  it("no service client: the join page could not read the row, so the OLD link is sent", async () => {
    state.adminOn = false;
    const res = await createInvitation(form("dana.rook@example.com", "tech"));
    expect(res.link).toContain("/login?mode=signup&email=");
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain(state.token!);
  });
});

describe("Copy Link uses the same builder", () => {
  it("invite-manager copies inviteCopyLink(siteUrl, email, token, joinReady), and builds no link by hand", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/settings/invite-manager.tsx"), "utf8");
    expect(src).toContain('import { inviteCopyLink } from "@/lib/invite-door";');
    expect(src).toContain("inviteCopyLink(siteUrl, email, token, joinReady)");
    expect(src).toContain("copyLink(inv.email, inv.token)");
    expect(src).not.toMatch(/auth\/join\?t=/);
    expect(src).not.toMatch(/mode=signup/);
  });

  it("Copy Link with joinReady false is the OLD link, exactly createInvitation's fallback (fixer #85, F5)", () => {
    const token = "ab".repeat(24);
    const email = "dana.rook@example.com";
    expect(inviteCopyLink(BASE, email, token, true)).toBe(inviteJoinLink(BASE, token));
    expect(inviteCopyLink(BASE, email, token, false)).toBe(inviteSignupLink(BASE, email));
    expect(inviteSignupLink(BASE, email)).toBe(`${BASE}/login?mode=signup&email=${encodeURIComponent(email)}`);
    expect(inviteCopyLink(BASE, email, "not-a-token", true)).toBe(inviteSignupLink(BASE, email));
  });

  it("the team page hands the list joinReady from the server, and the help text says what is true for each case", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/team/page.tsx"), "utf8");
    expect(page).toContain("joinReady={adminConfigured()}");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/settings/invite-manager.tsx"), "utf8");
    expect(src).toMatch(/\{joinReady \? \(/);
    expect(src).toContain("in your company");
    expect(src).not.toContain("on your company");
    // The second-email promise lives only on the joinReady branch.
    const noBranch = src.slice(src.indexOf(") : ("), src.indexOf('{" "}'));
    expect(noBranch).toContain("confirms it from a second email");
    expect(noBranch).not.toContain("no second email");
  });

  it("one plain slate line under the Copy Link doors: the link joins as the address on it (fixer #85, F4)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/settings/invite-manager.tsx"), "utf8");
    const line = "Whoever opens an invite link joins as the address on it. Check the address before you share a link.";
    expect(src).toContain(line);
    const at = src.indexOf(line);
    const tag = src.lastIndexOf("<p ", at);
    expect(src.slice(tag, at)).toContain("text-slate-500");
    expect(src.slice(tag, at)).not.toMatch(/amber/);
    expect(at).toBeGreaterThan(src.indexOf("</ul>"));
  });

  it("no other file builds the join link by hand", () => {
    const settings = readFileSync(join(process.cwd(), "src/app/(app)/settings/actions.ts"), "utf8");
    expect(settings).toContain("inviteJoinLink(base, row?.token)");
    expect(settings).not.toMatch(/auth\/join\?t=/);
  });

  it("the team page that feeds the list selects the token", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/team/page.tsx"), "utf8");
    expect(page).toMatch(/from\("invitations"\)\.select\("\*"\)/);
  });
});
