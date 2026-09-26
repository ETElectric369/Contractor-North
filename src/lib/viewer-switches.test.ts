import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE SWITCHES AND WHO IS LOOKING (0352), for the record pages that draw the Off line. A lost read
 * is "everything on, no Turn On": the page is exactly what it was before the switches existed.
 * Only the owner of an ACTIVE seat is told they can turn a switch on (set_org_feature's own rule).
 */
let user: { id: string } | null = { id: "u1" };
let row: unknown = null;
let readError: unknown = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      expect(table).toBe("profiles");
      return {
        select: (cols: string) => {
          expect(cols).toContain("organizations(settings)");
          return { eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: id === user?.id ? row : null, error: readError }) }) };
        },
      };
    },
  }),
}));

import { SWITCHES_UNREAD, switchesFromRow, viewerSwitches } from "./viewer-switches";
import { ALL_ON } from "./features";

describe("switchesFromRow", () => {
  it("nothing to read is everything on and no Turn On", () => {
    for (const r of [null, undefined, "x", {}]) expect(switchesFromRow(r)).toEqual(SWITCHES_UNREAD);
    expect(SWITCHES_UNREAD.features).toEqual(ALL_ON);
  });

  it("reads the company's stored switches through the read rule (missing = on)", () => {
    const s = switchesFromRow({ role: "office", organizations: { settings: { features: { leads: false } } } });
    expect(s.features.leads).toBe(false);
    expect(s.features.estimates).toBe(true);
    expect(s.isOwner).toBe(false);
  });

  it("tolerates the array shape of an embed", () => {
    expect(switchesFromRow({ role: "owner", organizations: [{ settings: { features: { kits: false } } }] }).features.kits).toBe(false);
  });

  it("only the owner of an active seat may turn a switch on", () => {
    expect(switchesFromRow({ role: "owner", organizations: null }).isOwner).toBe(true);
    expect(switchesFromRow({ role: "owner", active: false, organizations: null }).isOwner).toBe(false);
    for (const role of ["admin", "office", "tech"]) expect(switchesFromRow({ role }).isOwner).toBe(false);
  });
});

describe("viewerSwitches", () => {
  beforeEach(() => {
    user = { id: "u1" };
    row = null;
    readError = null;
  });

  it("reads the viewer's own profile with the company's settings embedded", async () => {
    row = { role: "owner", active: true, organizations: { settings: { features: { permits: false } } } };
    const s = await viewerSwitches();
    expect(s.isOwner).toBe(true);
    expect(s.features.permits).toBe(false);
  });

  it("signed out or a failed read: everything on, no Turn On", async () => {
    user = null;
    expect(await viewerSwitches()).toEqual(SWITCHES_UNREAD);
    user = { id: "u1" };
    row = { role: "owner", organizations: { settings: { features: { permits: false } } } };
    readError = { code: "42P01" };
    expect(await viewerSwitches()).toEqual(SWITCHES_UNREAD);
  });
});
