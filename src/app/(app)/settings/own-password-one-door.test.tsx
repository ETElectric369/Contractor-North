import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ONE DOOR FOR ONE'S OWN PASSWORD (cn-v1202). A person's own password is changed in Settings › You ›
 * Change My Password, and only there. The Team dialog (Edit & Role) on the person's OWN row draws no
 * password box, only a link to that door, whose words are the catalog's English, so they cannot
 * drift. And the admin action behind that dialog refuses a password for the caller's own id before
 * any admin call: that path can end the very session making the change. A change of the caller's own
 * email, and a password for another member, work as before.
 */
const state = vi.hoisted(() => ({
  client: null as any,
  adminCalls: [] as { id: string; attrs: Record<string, unknown> }[],
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
    from: () => ({ update: () => ({ eq: async () => ({ data: null, error: null }) }) }),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
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
    auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
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
  it("self + email still changes the email", async () => {
    expect(await updateMemberAuth("me", { email: "Sam@Example.com" })).toEqual({ ok: true });
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
