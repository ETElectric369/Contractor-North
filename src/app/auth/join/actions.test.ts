import { describe, it, expect, vi, beforeEach } from "vitest";
import { newWorld, serviceClient, cookieClient, type World } from "@/test/join-door-fake";

/**
 * THE ONE-STEP INVITE'S DOOR (cn-v1183). The token is the proof of the mailbox: the account is made
 * already confirmed for the INVITATION'S address (never a typed one), the person is signed in, the
 * one deactivation gate runs, the invitation is accepted, the other open ones in that company close,
 * and they land on /planner. Nothing is created in any other state; a never-confirmed account is
 * claimed in one write; a confirmed one is never touched; a malformed token reads nothing; the sink
 * never hears the token or an address.
 */
const state = vi.hoisted(() => ({
  world: null as unknown as World,
  acceptLanguage: "en-US,en;q=0.9",
  userAgent: "Mozilla/5.0",
  adminOn: true,
  deactivated: false,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "accept-language": state.acceptLanguage, "user-agent": state.userAgent })),
  cookies: vi.fn(async () => ({ getAll: () => [], set: () => {}, delete: () => {} })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    state.world.log.push(`redirect ${url}`);
    throw new Error(`REDIRECT ${url}`);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => cookieClient(state.world)),
  createServiceClient: vi.fn(() => serviceClient(state.world)),
}));
vi.mock("@/lib/supabase/admin", () => ({ adminConfigured: () => state.adminOn }));
vi.mock("@/lib/deactivation-gate", () => ({
  endSessionIfDeactivated: vi.fn(async () => {
    state.world.log.push("gate");
    return state.deactivated;
  }),
}));
vi.mock("@/app/(app)/settings/actions", () => ({
  setLanguage: vi.fn(async (l: string) => {
    state.world.log.push(`language ${l}`);
    return { ok: true };
  }),
}));

import { joinWithInvite, joinSignedIn } from "./actions";
import { reportError } from "@/lib/observe";
import { dict, fillText } from "@/lib/i18n";

const TOKEN = "ab".repeat(24);
const OTHER_TOKEN = "cd".repeat(24);
const EMAIL = "dana.rook@example.com";
const ORG = "org-larkspur";

function seed(w: World) {
  w.tables.organizations.push({ id: ORG, name: "Larkspur Electric" }, { id: "org-northline", name: "Northline Supply" });
  w.tables.invitations.push(
    { id: "inv-1", token: TOKEN, org_id: ORG, email: EMAIL, role: "tech", accepted_at: null, expires_at: "2026-12-06T12:00:00Z", created_at: "2026-11-20T00:00:00Z" },
    // An older open invitation to the same address in the same company: closed by the join.
    { id: "inv-0", token: OTHER_TOKEN, org_id: ORG, email: EMAIL, role: "tech", accepted_at: null, expires_at: "2026-12-01T12:00:00Z", created_at: "2026-11-17T00:00:00Z" },
    // Someone else's open invitation in the same company: untouched.
    { id: "inv-9", token: "ef".repeat(24), org_id: ORG, email: "theo.vance@example.com", role: "office", accepted_at: null, expires_at: "2026-12-06T12:00:00Z", created_at: "2026-11-20T00:00:00Z" },
  );
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const GOOD = { t: TOKEN, full_name: "Dana Rook", password: "secret-123" };
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const m = String((e as Error).message);
    if (m.startsWith("REDIRECT ")) return decodeURIComponent(m.slice(9));
    throw e;
  }
  throw new Error("no redirect");
};
const adminNames = () => state.world.adminCalls.map((c) => c.name);
const JOIN = `/auth/join?t=${TOKEN}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
  state.world = newWorld();
  seed(state.world);
  state.acceptLanguage = "en-US,en;q=0.9";
  state.userAgent = "Mozilla/5.0";
  state.adminOn = true;
  state.deactivated = false;
  vi.mocked(reportError).mockClear();
});

describe("joinWithInvite: the happy path", () => {
  it("creates the account CONFIRMED for the invitation's address (a typed email is ignored), signs in, gates, accepts, closes the others, lands", async () => {
    const to = await redirectOf(joinWithInvite(form({ ...GOOD, email: "casey.loam@example.com" })));
    expect(to).toBe("/planner");
    const create = state.world.adminCalls.find((c) => c.name === "createUser")!;
    expect(create.args[0]).toEqual({ email: EMAIL, password: "secret-123", email_confirm: true, user_metadata: { full_name: "Dana Rook" } });
    expect(state.world.log).toEqual(["createUser", "signIn", "gate", "accept", "tidy", "redirect /planner"]);
    const prof = state.world.tables.profiles.find((p) => p.email === EMAIL)!;
    expect(prof.org_id).toBe(ORG);
    const inv = (id: string) => state.world.tables.invitations.find((i) => i.id === id)!;
    expect(inv("inv-1").accepted_at).not.toBeNull();
    expect(inv("inv-0").accepted_at).not.toBeNull();
    expect(inv("inv-9").accepted_at).toBeNull();
    // The tidy names the company, the address and only open rows.
    const tidy = state.world.writes.find((w) => w.table === "invitations")!;
    expect(tidy.filters).toEqual([
      ["eq", "org_id", ORG],
      ["eq", "email", EMAIL],
      ["is", "accepted_at", null],
    ]);
    expect(state.world.users.some((u) => u.email === "casey.loam@example.com")).toBe(false);
    expect(adminNames()).not.toContain("updateUserById");
  });

  it("a Spanish page: the profile follows through the language switch's own door, after the accept", async () => {
    state.acceptLanguage = "es-MX,es;q=0.9";
    await redirectOf(joinWithInvite(form(GOOD)));
    expect(state.world.log).toEqual(["createUser", "signIn", "gate", "accept", "tidy", "language es", "redirect /planner"]);
  });
});

describe("joinWithInvite: nothing is created where the door does not say create", () => {
  const cases: [string, (w: World) => void][] = [
    ["invalid (no such token)", (w) => (w.tables.invitations = w.tables.invitations.filter((i) => i.id !== "inv-1"))],
    ["used", (w) => (w.tables.invitations[0].accepted_at = "2026-11-21T00:00:00Z")],
    ["expired", (w) => (w.tables.invitations[0].expires_at = "2026-11-22T11:00:00Z")],
    [
      "superseded",
      (w) =>
        w.tables.invitations.push({ id: "inv-n", token: "12".repeat(24), org_id: "org-northline", email: EMAIL, role: "tech", accepted_at: null, expires_at: "2026-12-07T00:00:00Z", created_at: "2026-11-21T00:00:00Z" }),
    ],
    ["shell", () => (state.userAgent = "Mozilla/5.0 CNShell/1 (iOS)")],
    [
      "sign_in_first (a confirmed account)",
      (w) => {
        w.users.push({ id: "u-dana", email: EMAIL, password: "theirs-already", email_confirmed_at: "2026-11-01T00:00:00Z", last_sign_in_at: null });
        w.tables.profiles.push({ id: "u-dana", email: EMAIL, org_id: null, active: true });
      },
    ],
    [
      "sign_in_first (an account that signed in once)",
      (w) => {
        w.users.push({ id: "u-dana", email: EMAIL, password: "theirs-already", email_confirmed_at: null, last_sign_in_at: "2026-11-01T00:00:00Z" });
        w.tables.profiles.push({ id: "u-dana", email: EMAIL, org_id: null, active: true });
      },
    ],
    [
      "other_company",
      (w) => {
        w.users.push({ id: "u-dana", email: EMAIL, password: "theirs-already", email_confirmed_at: "2026-11-01T00:00:00Z", last_sign_in_at: "2026-11-02T00:00:00Z" });
        w.tables.profiles.push({ id: "u-dana", email: EMAIL, org_id: "org-northline", active: true });
      },
    ],
  ];
  it.each(cases)("%s", async (_name, arrange) => {
    arrange(state.world);
    const before = state.world.users.map((u) => ({ ...u }));
    const to = await redirectOf(joinWithInvite(form(GOOD)));
    expect(to).toBe(JOIN);
    expect(adminNames()).not.toContain("createUser");
    expect(adminNames()).not.toContain("updateUserById");
    expect(state.world.users).toEqual(before);
    expect(state.world.log.filter((l) => !l.startsWith("redirect"))).toEqual([]);
  });

  it("a session on the phone is never a create: back to the page, which says the state", async () => {
    state.world.users.push({ id: "u-theo", email: "theo.vance@example.com", password: "x", email_confirmed_at: "2026-11-01T00:00:00Z", last_sign_in_at: "2026-11-01T00:00:00Z" });
    state.world.tables.profiles.push({ id: "u-theo", email: "theo.vance@example.com", org_id: null, active: true });
    state.world.session = "u-theo";
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe(JOIN);
    expect(adminNames()).not.toContain("createUser");
  });

  it("a short password or a missing name goes back with the sentence and creates nothing", async () => {
    expect(await redirectOf(joinWithInvite(form({ ...GOOD, password: "12345" })))).toBe(`${JOIN}&e=password`);
    expect(await redirectOf(joinWithInvite(form({ ...GOOD, full_name: "   " })))).toBe(`${JOIN}&e=name`);
    expect(await redirectOf(joinWithInvite(form({ ...GOOD, full_name: "x".repeat(121) })))).toBe(`${JOIN}&e=name`);
    expect(adminNames()).not.toContain("createUser");
  });

  it("no service client: the link can't be opened right now, and nothing is read or made", async () => {
    state.adminOn = false;
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe(`${JOIN}&e=unavailable`);
    expect(state.world.froms).toEqual([]);
    expect(state.world.adminCalls).toEqual([]);
  });
});

describe("joinWithInvite: the claim", () => {
  beforeEach(() => {
    // Someone started the old sign-up form with the invited address and a password of their own.
    state.world.users.push({ id: "u-claim", email: EMAIL, password: "a-strangers", email_confirmed_at: null, last_sign_in_at: null });
    state.world.tables.profiles.push({ id: "u-claim", email: EMAIL, full_name: "Someone", org_id: null, active: true });
  });

  it("replaces the password AND confirms in ONE call, never createUser; the name is written by id", async () => {
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe("/planner");
    const upd = state.world.adminCalls.filter((c) => c.name === "updateUserById");
    expect(upd).toHaveLength(1);
    expect(upd[0].args).toEqual(["u-claim", { password: "secret-123", email_confirm: true, user_metadata: { full_name: "Dana Rook" } }]);
    expect(adminNames()).not.toContain("createUser");
    expect(state.world.users[0].password).toBe("secret-123");
    const named = state.world.writes.find((w) => w.table === "profiles")!;
    expect(named.patch).toEqual({ full_name: "Dana Rook" });
    expect(named.filters).toEqual([["eq", "id", "u-claim"]]);
    expect(state.world.log).toEqual(["updateUserById", "signIn", "gate", "accept", "tidy", "redirect /planner"]);
  });

  it("a profile whose auth user holds ANOTHER address is ignored: no claim of it, and the invitee's account is made (fixer #85, S1)", async () => {
    // A signed-in stranger typed the invited address into their own profile.
    state.world.users[0].email = "casey.loam@example.com";
    state.world.users[0].email_confirmed_at = "2026-11-01T00:00:00Z";
    state.world.users[0].last_sign_in_at = "2026-11-01T00:00:00Z";
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe("/planner");
    expect(adminNames()).not.toContain("updateUserById");
    expect(state.world.adminCalls.find((c) => c.name === "createUser")!.args[0]).toMatchObject({ email: EMAIL, email_confirm: true });
    // The stranger's account is untouched.
    expect(state.world.users[0]).toMatchObject({ id: "u-claim", email: "casey.loam@example.com", password: "a-strangers" });
  });

  it("a stranger's profile beside the real never-confirmed account cannot switch the claim off", async () => {
    state.world.users.push({ id: "u-stranger", email: "casey.loam@example.com", password: "x", email_confirmed_at: "2026-11-01T00:00:00Z", last_sign_in_at: "2026-11-01T00:00:00Z" });
    state.world.tables.profiles.push({ id: "u-stranger", email: EMAIL, org_id: "org-northline", active: true });
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe("/planner");
    const upd = state.world.adminCalls.filter((c) => c.name === "updateUserById");
    expect(upd).toHaveLength(1);
    expect(upd[0].args[0]).toBe("u-claim");
    expect(adminNames()).not.toContain("createUser");
  });

  it("more than one profile the auth service agrees holds the address is never a claim", async () => {
    state.world.users.push({ id: "u-twin", email: EMAIL, password: "x", email_confirmed_at: null, last_sign_in_at: null });
    state.world.tables.profiles.push({ id: "u-twin", email: EMAIL, org_id: null, active: true });
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe(JOIN);
    expect(adminNames()).toEqual(["getUserById", "getUserById"]);
  });

  it("a failed ask of the auth service is 'unavailable', never a guess", async () => {
    state.world.fail.getUserById = { code: "unexpected_failure", status: 500, message: "boom" };
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe(`${JOIN}&e=unavailable`);
    expect(adminNames()).toEqual(["getUserById"]);
  });
});

describe("joinWithInvite: refusals and failures", () => {
  it("a malformed token makes NO database read", async () => {
    for (const t of ["", "AB".repeat(24), "ab".repeat(23), `${TOKEN}x`, "' or 1=1 --"]) {
      expect(await redirectOf(joinWithInvite(form({ ...GOOD, t })))).toBe("/auth/join");
      expect(await redirectOf(joinSignedIn(form({ t })))).toBe("/auth/join");
    }
    expect(state.world.froms).toEqual([]);
    expect(state.world.adminCalls).toEqual([]);
  });

  it("an already-registered answer goes to sign-in with the way back, never the same form again (no loop), never a claim (fixer #85, S2)", async () => {
    state.world.users.push({ id: "u-drift", email: EMAIL, password: "x", email_confirmed_at: "2026-11-01T00:00:00Z", last_sign_in_at: null });
    const to = await redirectOf(joinWithInvite(form(GOOD)));
    expect(to).toBe(`/login?email=${EMAIL}&next=${JOIN}&message=${fillText(dict("en").au_joinSignInFirst, { company: "Larkspur Electric" })}`);
    expect(to.startsWith("/auth/join")).toBe(false);
    expect(adminNames()).toEqual(["createUser"]);
  });

  it("GoTrue's own password refusal is said back as it came", async () => {
    state.world.fail.createUser = { code: "weak_password", message: "Password is known to be weak and easy to guess, please choose a different one." };
    // As a CODE: GoTrue's English sentence never rides the URL.
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe(`${JOIN}&e=weak`);
  });

  it("any other failure says the account couldn't be created; the sink never hears the token or an address", async () => {
    state.world.fail.createUser = { code: "unexpected_failure", status: 500, message: `Database error saving new user ${EMAIL} ${TOKEN}` };
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe(`${JOIN}&e=failed`);
    expect(reportError).toHaveBeenCalled();
    state.world.fail = { profilesRead: { code: "XX000", message: `read failed for ${EMAIL}` } };
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe(`${JOIN}&e=unavailable`);
    state.world.fail = { accept: { message: "No pending invitation for your email." } };
    await redirectOf(joinWithInvite(form(GOOD)));
    const said = JSON.stringify(vi.mocked(reportError).mock.calls.map(([w, e, x]) => [w, String((e as Error)?.message ?? e), x]));
    expect(vi.mocked(reportError).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(said).not.toContain(TOKEN);
    expect(said.toLowerCase()).not.toContain("example.com");
    expect(said).toContain("inv-1");
  });

  it("a failed sign-in after the create lands on /login with the ready sentence and the way back", async () => {
    state.world.fail.signIn = { message: "Invalid login credentials" };
    const to = await redirectOf(joinWithInvite(form(GOOD)));
    expect(to).toBe(
      `/login?email=${EMAIL}&next=${JOIN}&message=${fillText(dict("en").au_joinReadySignIn, { company: "Larkspur Electric" })}`,
    );
    expect(state.world.log).not.toContain("accept");
  });

  it("a deactivated seat gets no session and joins nothing", async () => {
    state.deactivated = true;
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe(`/login?error=${dict("en").au_deactivated}`);
    expect(state.world.log).not.toContain("accept");
  });

  it("a failed accept lands on /onboarding, signed in, where Join is offered", async () => {
    state.world.fail.accept = { message: "No pending invitation for your email." };
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe("/onboarding?error=No pending invitation for your email.");
    expect(state.world.log).not.toContain("tidy");
  });
});

describe("the claim's metadata (fixer #85, F7)", () => {
  it("passes only full_name, and says beside it that the admin update MERGES metadata", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(process.cwd(), "src/app/auth/join/actions.ts"), "utf8") as string;
    const at = src.indexOf("svc.auth.admin.updateUserById(");
    const before = src.slice(src.lastIndexOf("// ONE write", at), at);
    expect(before).toMatch(/MERGES metadata/);
    expect(before).toMatch(/Only full_name is read anywhere/);
    expect(src.slice(at, src.indexOf("});", at))).toContain("user_metadata: { full_name: fullName }");
  });
});

describe("the seat after the accept (fixer #85, S3)", () => {
  it("a role that is not the invitation's is said to the sink (the invitation id only); they still land", async () => {
    // A newer open row in the SAME company with another role: accept_invitation() takes the newest.
    state.world.tables.invitations.push({ id: "inv-2", token: "34".repeat(24), org_id: ORG, email: EMAIL, role: "admin", accepted_at: null, expires_at: "2026-12-06T12:00:00Z", created_at: "2026-11-21T00:00:00Z" });
    expect(await redirectOf(joinWithInvite(form(GOOD)))).toBe("/planner");
    const call = vi.mocked(reportError).mock.calls.find((c) => c[0] === "joinInvite.otherRole");
    expect(call).toBeTruthy();
    expect(call![2]).toEqual({ invitationId: "inv-1" });
    const said = JSON.stringify(call);
    expect(said).not.toContain(TOKEN);
    expect(said).not.toContain("example.com");
  });

  it("the invitation's own role is not reported", async () => {
    await redirectOf(joinWithInvite(form(GOOD)));
    expect(vi.mocked(reportError).mock.calls.map((c) => c[0])).not.toContain("joinInvite.otherRole");
  });
});

describe("joinSignedIn", () => {
  const signedIn = (email: string, orgId: string | null = null) => {
    state.world.users.push({ id: "u-s", email, password: "x", email_confirmed_at: "2026-11-01T00:00:00Z", last_sign_in_at: "2026-11-01T00:00:00Z" });
    state.world.tables.profiles.push({ id: "u-s", email, org_id: orgId, active: true });
    state.world.session = "u-s";
  };

  it("the invited address with no company: gate, accept, close the others, land", async () => {
    signedIn(EMAIL);
    expect(await redirectOf(joinSignedIn(form({ t: TOKEN })))).toBe("/planner");
    expect(state.world.log).toEqual(["gate", "accept", "tidy", "redirect /planner"]);
    expect(state.world.adminCalls.map((c) => c.name)).toEqual(["getUserById"]);
  });

  it("refuses a session whose email is not the invitation's", async () => {
    signedIn("casey.loam@example.com");
    expect(await redirectOf(joinSignedIn(form({ t: TOKEN })))).toBe(JOIN);
    expect(state.world.log).not.toContain("accept");
  });

  it("refuses a session that already has a company", async () => {
    signedIn(EMAIL, "org-northline");
    expect(await redirectOf(joinSignedIn(form({ t: TOKEN })))).toBe(JOIN);
    expect(state.world.log).not.toContain("accept");
  });

  it("refuses with no session at all", async () => {
    expect(await redirectOf(joinSignedIn(form({ t: TOKEN })))).toBe(JOIN);
    expect(state.world.log).not.toContain("accept");
  });
});
