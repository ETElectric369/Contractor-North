import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ONE DOOR FOR ONE'S OWN PASSWORD (cn-v1202). A person's own password is changed in Settings › You ›
 * Change My Password, and only there. The Team dialog (Edit & Role) on the person's OWN row draws no
 * password box, only a link to that door, whose words are the catalog's English, so they cannot
 * drift. And the admin action behind that dialog refuses a password for the caller's own id before
 * any admin call: that path can end the very session making the change. A password for another
 * member works as before; a change of the caller's own email asks for the current password (below).
 * ONE'S OWN EMAIL ASKS FOR THE CURRENT PASSWORD (cn-v1203, after skeptic #100): a new login email for
 * the caller's own id needs the current password, checked (lib/supabase/password-check, stood in
 * here) before any admin call; without it, a changed email plus a reset to the new address walked
 * around the current-password rule. The dialog draws that box on the own row only, once the Email
 * box differs. An unchanged own email (any letter case) and another member's email need none.
 */
const state = vi.hoisted(() => ({
  client: null as any,
  adminCalls: [] as { id: string; attrs: Record<string, unknown> }[],
  profileWrites: [] as { patch: unknown; id: unknown }[],
  check: { result: "ok", code: null, status: null } as { result: "ok" | "wrong" | "unknown"; code: string | null; status: number | null },
  checkArgs: [] as unknown[][],
  userEmail: "sam.tillery@example.com" as string | undefined,
  /** The dialog's hooks held by hand (cn-v1203), only for the cases that type into the dialog. */
  hand: false,
  states: [] as unknown[],
  i: 0,
  pending: [] as Promise<unknown>[],
}));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      if (!state.hand) return real.useState(init);
      const i = state.i++;
      if (!(i in state.states)) state.states[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [state.states[i], (v: unknown) => (state.states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(state.states[i]) : v)];
    },
    useTransition: () => {
      if (!state.hand) return real.useTransition();
      return [false, (fn: () => unknown) => void state.pending.push(Promise.resolve(fn()))];
    },
  };
});
vi.mock("@/lib/supabase/password-check", () => ({
  checkCurrentPassword: async (...a: unknown[]) => {
    state.checkArgs.push(a);
    return state.check;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("@/lib/supabase/admin", () => ({
  adminConfigured: () => true,
  createAdminClient: () => ({
    auth: {
      admin: {
        updateUserById: async (id: string, attrs: Record<string, unknown>) => {
          state.adminCalls.push({ id, attrs });
          return { data: {}, error: null };
        },
      },
    },
    from: () => ({
      update: (patch: unknown) => ({
        eq: async (_c: string, id: unknown) => {
          state.profileWrites.push({ patch, id });
          return { data: null, error: null };
        },
      }),
    }),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const reportError = vi.fn();
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {}, push() {} }) }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ModalActions: () => null,
}));

import { updateMemberAuth } from "./actions";
import { EditMemberButton } from "./edit-member-button";
import { dict } from "@/lib/i18n";

type Row = { id: string; org_id: string; role: string; active?: boolean };
const ROWS: Row[] = [
  { id: "me", org_id: "org-1", role: "owner", active: true },
  { id: "dana", org_id: "org-1", role: "tech" },
];
function fake() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "me", email: state.userEmail } } }) },
    from() {
      const filters: [string, unknown][] = [];
      const chain: any = {
        select: () => chain,
        eq(c: string, v: unknown) {
          filters.push([c, v]);
          return chain;
        },
        maybeSingle: async () => ({ data: ROWS.find((r) => filters.every(([c, v]) => (r as any)[c] === v)) ?? null, error: null }),
      };
      return chain;
    },
  };
}
/** Built at run time: never a literal with the shape of a real password. */
const pw = () => ["larkspur", "meadow", String(6 * 7)].join("-");

beforeEach(() => {
  state.client = fake();
  state.adminCalls = [];
  state.profileWrites = [];
  state.check = { result: "ok", code: null, status: null };
  state.checkArgs = [];
  state.userEmail = "sam.tillery@example.com";
  state.hand = false;
  state.states = [];
  state.pending = [];
  reportError.mockClear();
});

describe("the action: one's own password is refused here", () => {
  it("self + password is refused before any admin call", async () => {
    const res = await updateMemberAuth("me", { password: pw() });
    expect(res).toEqual({ ok: false, error: "Change your own password in Settings › You › Change My Password." });
    expect(state.adminCalls).toEqual([]);
    const both = await updateMemberAuth("me", { email: "sam@example.com", password: pw() });
    expect(both.ok).toBe(false);
    expect(state.adminCalls).toEqual([]);
  });
  it("self + a new email with the current password (a match) still changes the email", async () => {
    const cur = pw();
    expect(await updateMemberAuth("me", { email: "Sam@Example.com", currentPassword: cur })).toEqual({ ok: true });
    expect(state.checkArgs).toEqual([["sam.tillery@example.com", cur]]);
    expect(state.adminCalls).toEqual([{ id: "me", attrs: { email: "sam@example.com" } }]);
  });
  it("another member + password still works", async () => {
    const p = pw();
    expect(await updateMemberAuth("dana", { password: p })).toEqual({ ok: true });
    expect(state.adminCalls).toEqual([{ id: "dana", attrs: { password: p } }]);
  });
});

describe("the dialog: the self row draws a link, not a box", () => {
  const member = { id: "me", full_name: "Sam Tillery", email: "sam@example.com", role: "owner" };
  const render = (isSelf: boolean) =>
    renderToStaticMarkup(createElement(EditMemberButton, { member: isSelf ? member : { ...member, id: "dana", full_name: "Dana Rook", role: "tech" }, isSelf, authConfigured: true }));

  it("self: no m-pw box, one link to Settings › You › Change My Password in the catalog's English", () => {
    const html = render(true);
    expect(html).not.toContain('id="m-pw"');
    expect(html).not.toContain("Toggle password");
    expect(html).toContain('id="m-email"');
    const en = dict("en");
    const link = html.match(/<a[^>]*href="\/settings\?tab=you"[^>]*>([^<]*)<\/a>/);
    expect(link?.[1]).toBe(en.sh_changeMyPassword);
    expect(html).toContain(`To change your own password, use <a`);
    expect(html).toContain(`</a> in Settings › ${en.sh_you}.`);
  });
  it("another member: the password box is still drawn", () => {
    const html = render(false);
    expect(html).toContain('id="m-pw"');
    expect(html).toContain('id="m-email"');
    expect(html).not.toContain('href="/settings?tab=you"');
  });
});

describe("one's own email asks for the current password (cn-v1203)", () => {
  const en = dict("en");
  it("self + a new email + no current password (missing, empty, a non-string): refused, no check, the admin client never reached", async () => {
    for (const currentPassword of [undefined, "", 12345678, { toString: () => "x" }]) {
      expect(await updateMemberAuth("me", { email: "dana.rook@example.com", currentPassword: currentPassword as unknown as string })).toEqual({
        ok: false,
        error: "Enter your current password to change your own email.",
      });
    }
    expect(state.checkArgs).toEqual([]);
    expect(state.adminCalls).toEqual([]);
    expect(state.profileWrites).toEqual([]);
  });
  it("self + a new email + the wrong current password: the catalog's English wrong sentence, nothing changed, nothing reported", async () => {
    state.check = { result: "wrong", code: "invalid_credentials", status: 400 };
    const res = await updateMemberAuth("me", { email: "dana.rook@example.com", currentPassword: pw() });
    expect(res).toEqual({ ok: false, error: en.au_currentPasswordWrong });
    expect(state.adminCalls).toEqual([]);
    expect(state.profileWrites).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });
  it("self + a new email + could not check: the catalog's English unchecked sentence, ONE report with code and status only", async () => {
    state.check = { result: "unknown", code: "over_request_rate_limit", status: 429 };
    const cur = pw();
    const res = await updateMemberAuth("me", { email: "dana.rook@example.com", currentPassword: cur });
    expect(res).toEqual({ ok: false, error: en.au_currentPasswordUnchecked });
    expect(state.adminCalls).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [where, err, extra] = reportError.mock.calls[0];
    expect(where).toBe("member-auth-check-current");
    expect(extra).toEqual({ code: "over_request_rate_limit", status: 429 });
    const said = JSON.stringify([String(err), (err as Error).message, extra]);
    for (const secret of [cur, "sam.tillery@example.com", "dana.rook@example.com", "example.com"]) expect(said).not.toContain(secret);
  });
  it("self + a new email + a match: updateUserById(id, { email }) and the profile's email written, as before", async () => {
    expect(await updateMemberAuth("me", { email: " Dana.Rook@Example.com ", currentPassword: pw() })).toEqual({ ok: true });
    expect(state.adminCalls).toEqual([{ id: "me", attrs: { email: "dana.rook@example.com" } }]);
    expect(state.profileWrites).toEqual([{ patch: { email: "dana.rook@example.com" }, id: "me" }]);
  });
  it("self + the same email in other letter case: no check, nothing asked", async () => {
    expect(await updateMemberAuth("me", { email: " SAM.Tillery@Example.COM " })).toEqual({ ok: true });
    // And a login email stored with capitals is the same address typed in small letters.
    state.userEmail = "Sam.Tillery@Example.com";
    expect(await updateMemberAuth("me", { email: "sam.tillery@example.com" })).toEqual({ ok: true });
    expect(state.checkArgs).toEqual([]);
  });
  it("self + a new email when the login carries no email: could not check, reported, nothing changed", async () => {
    state.userEmail = undefined;
    expect(await updateMemberAuth("me", { email: "dana.rook@example.com", currentPassword: pw() })).toEqual({ ok: false, error: dict("en").au_currentPasswordUnchecked });
    expect(state.checkArgs).toEqual([]);
    expect(state.adminCalls).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
  it("another member + a new email: no check, changed as before", async () => {
    expect(await updateMemberAuth("dana", { email: "dana.rook@example.com" })).toEqual({ ok: true });
    expect(state.checkArgs).toEqual([]);
    expect(state.adminCalls).toEqual([{ id: "dana", attrs: { email: "dana.rook@example.com" } }]);
  });
  it("the own-password refusal still comes first, before any check", async () => {
    const res = await updateMemberAuth("me", { email: "dana.rook@example.com", password: pw(), currentPassword: pw() });
    expect(res).toEqual({ ok: false, error: "Change your own password in Settings › You › Change My Password." });
    expect(state.checkArgs).toEqual([]);
  });
});

describe("the dialog's Current password box (cn-v1203)", () => {
  type El = ReactElement<Record<string, any>>;
  const all = (node: ReactNode, out: El[] = []): El[] => {
    if (Array.isArray(node)) node.forEach((n) => all(n, out));
    else if (isValidElement(node)) {
      out.push(node as El);
      const p = (node as El).props;
      all(p.children, out);
      if (p.footer) all(p.footer, out);
    }
    return out;
  };
  const self = { id: "me", full_name: "Sam Tillery", email: "sam.tillery@example.com", role: "owner" };
  const other = { id: "dana", full_name: "Dana Rook", email: "dana.rook@example.com", role: "tech" };
  function draw(isSelf: boolean): El {
    state.i = 0;
    return (EditMemberButton as unknown as (p: unknown) => El)({ member: isSelf ? self : other, isSelf, authConfigured: true });
  }
  const html = (tree: El) => renderToStaticMarkup(tree);
  const typeEmail = (isSelf: boolean, value: string) => all(draw(isSelf)).find((e) => e.props.id === "m-email")!.props.onChange({ target: { value } });

  it("own row: no box while the email is the saved one (any letter case); the box, its label and hint once it differs", () => {
    state.hand = true;
    expect(html(draw(true))).not.toContain('id="m-cur"');
    typeEmail(true, " SAM.TILLERY@example.com ");
    expect(html(draw(true))).not.toContain('id="m-cur"');
    typeEmail(true, "dana.rook@example.com");
    const out = html(draw(true));
    const box = out.match(/<input[^>]*id="m-cur"[^>]*\/>/)?.[0] ?? "";
    expect(box).toContain('type="password"');
    expect(box).toContain('autoComplete="current-password"');
    expect(out).toMatch(/<label[^>]*for="m-cur"[^>]*>Current password<\/label>/);
    expect(out).toContain("Needed to change your own email.");
    expect(out.indexOf('id="m-email"')).toBeLessThan(out.indexOf('id="m-cur"'));
  });
  it("another member's row: never the box, whatever the email", () => {
    state.hand = true;
    typeEmail(false, "sam.tillery@example.com");
    expect(html(draw(false))).not.toContain('id="m-cur"');
  });
  it("the save sends what was typed as currentPassword, and the box is emptied after it", async () => {
    state.hand = true;
    typeEmail(true, "dana.rook@example.com");
    const cur = pw();
    all(draw(true)).find((e) => e.props.id === "m-cur")!.props.onChange({ target: { value: cur } });
    all(draw(true)).find((e) => typeof e.props.onSave === "function")!.props.onSave();
    while (state.pending.length) await state.pending.shift();
    expect(state.checkArgs).toEqual([["sam.tillery@example.com", cur]]);
    expect(state.adminCalls).toEqual([{ id: "me", attrs: { email: "dana.rook@example.com" } }]);
    expect(all(draw(true)).find((e) => e.props.id === "m-cur")?.props.value ?? "").toBe("");
    expect(html(draw(true))).toContain("Saved.");
  });
  it("its English literals equal the catalog's English, so they cannot drift", () => {
    const en = dict("en");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/settings/edit-member-button.tsx"), "utf8");
    expect(src).toContain(`<Label htmlFor="m-cur">${en.au_currentPassword}</Label>`);
    const action = readFileSync(join(process.cwd(), "src/app/(app)/settings/actions.ts"), "utf8");
    expect(action).toContain(`error: ${JSON.stringify(en.au_currentPasswordWrong)}`);
    expect(action).toContain(`error: ${JSON.stringify(en.au_currentPasswordUnchecked)}`);
  });
});
