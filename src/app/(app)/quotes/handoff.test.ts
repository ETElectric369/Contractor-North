import { describe, it, expect } from "vitest";
import { browserStash, handoffKey, stashHandoff, takeHandoff, type Handoff, type StorageLike } from "./handoff";

/**
 * THE HAND-OFF STASH (cn-v1132, S6), driven over a Map-backed store: what the new page puts under the
 * estimate's key is exactly what the saved page takes back, once, shaped; junk is nothing; a store
 * that is missing or refuses is "nothing to carry", never a throw into the navigation.
 */
function store(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
const rule = { label: null, person_id: null, hours: 2, rate: 145, rate_from: "rule" as const };
const h: Handoff = {
  scope: "Replace the panel at 12 Bayberry Ln",
  proposed: [
    { pid: 0, keep: true, description: "Panel, 200A", quantity: 1, unit: "ea", unit_price: 1800, group: "Tasks", detail: { task_id: "t1", labor: [rule], units: null, kit_id: null, materials: [] } },
    { pid: 1, keep: false, description: "Permit", quantity: 1, unit: "ea", unit_price: 250, flag: "price?" },
  ],
  questions: ["Is the service underground?"],
  number: "E-012",
};

describe("stash and take", () => {
  it("round-trips the scope, the proposals (pid, keep, group, flag, the breakdown coerced), the questions and the number — once", () => {
    const s = store();
    expect(stashHandoff(s, "q1", h)).toBe(true);
    expect(s.map.has(handoffKey("q1"))).toBe(true);
    expect(handoffKey("q1")).toBe("handoff:quote:q1");
    const got = takeHandoff(s, "q1");
    // The breakdown comes back coerced (its flag rebuilt: nothing missing here, so none); the plain
    // line keeps the flag the estimator gave it.
    expect(got).toEqual(h);
    // Taken once: the key is gone, a second take is nothing, and a reload restores nothing.
    expect(s.map.size).toBe(0);
    expect(takeHandoff(s, "q1")).toBeNull();
  });

  it("another estimate's key is not this one's", () => {
    const s = store();
    stashHandoff(s, "q1", h);
    expect(takeHandoff(s, "q2")).toBeNull();
    expect(takeHandoff(s, "q1")?.number).toBe("E-012");
  });

  it("junk under the key is nothing; a proposal with no description is dropped; missing parts default", () => {
    const s = store();
    s.setItem(handoffKey("q1"), "{not json");
    expect(takeHandoff(s, "q1")).toBeNull();
    s.setItem(handoffKey("q1"), JSON.stringify({ proposed: [{ quantity: 2 }, { description: "Trench", quantity: "3", unit_price: "290", kind: "labor" }, "x"], questions: ["a", 4], number: "" }));
    expect(takeHandoff(s, "q1")).toEqual({
      scope: "",
      // A proposal with no pid takes its place in the kept list.
      proposed: [{ description: "Trench", quantity: 3, unit: "ea", unit_price: 290, kind: "labor", pid: 0, keep: true }],
      questions: ["a"],
      number: null,
    });
    s.setItem(handoffKey("q1"), JSON.stringify(null));
    expect(takeHandoff(s, "q1")).toBeNull();
  });

  it("no store, or a store that refuses: nothing is carried and nothing throws", () => {
    expect(stashHandoff(null, "q1", h)).toBe(false);
    expect(takeHandoff(null, "q1")).toBeNull();
    const refusing: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(stashHandoff(refusing, "q1", h)).toBe(false);
    expect(takeHandoff(refusing, "q1")).toBeNull();
    // A server render has no window: null, not a throw.
    expect(browserStash()).toBeNull();
  });
});
