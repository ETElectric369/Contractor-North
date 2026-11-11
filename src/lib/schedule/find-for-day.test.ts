import { describe, it, expect } from "vitest";
import {
  FIND_CUSTOMER_CAP,
  FIND_MIN_CHARS,
  FIND_PAST_CAP,
  capFound,
  customerLine,
  customerSays,
  findWords,
  likeWord,
  mergeById,
  pastJobLine,
  pastJobSays,
  placeWords,
  saysEvery,
  type FoundCustomer,
  type PastJob,
} from "./find-for-day";
import { ACTIVE_JOB_STATUSES, ENDED_JOB_STATUSES, JOB_STATUSES } from "@/lib/job-status";

/**
 * WHAT ADD TO SCHEDULE CAN FIND BESIDES THE JOBS IN FLIGHT (cn-v1159; Erik, 2026-11-10: "not even an
 * address or a person as it states it can find"). The rule the route and the sheet share: the words of
 * a search, the one word the database is asked for, and the every-word match over what comes back.
 */
const past: PastJob[] = [
  { id: "p1", name: "41 Larkspur Ln #5", status: "complete", address: "41 Larkspur Ln", unit: "5", city: "Truckee", job_number: "J-045", customers: { name: "Dana Rook" } },
  { id: "p2", name: "Panel Upgrade", status: "cancelled", address: "12 Snowbell Rd, Truckee, CA 96161", unit: null, city: "Truckee", job_number: "J-050", customers: { name: "Sam Tillery" } },
  { id: "p3", name: "Theo Vance", status: "complete", address: null, unit: null, city: null, job_number: "J-051", customers: { name: "Theo Vance" } },
];
const people: FoundCustomer[] = [
  { id: "c1", name: "Dana Rook", company_name: null, address: "9 Bayberry Ct", unit: "B", city: "Truckee" },
  { id: "c2", name: "Casey Loam", company_name: "Catbird Builders", address: null, unit: null, city: "Kings Beach" },
];

describe("the statuses a place to go back to has", () => {
  it("everything on the spine that is not in flight, worked out and never listed", () => {
    expect(ENDED_JOB_STATUSES).toEqual(["complete", "cancelled"]);
    expect([...ACTIVE_JOB_STATUSES, ...ENDED_JOB_STATUSES].sort()).toEqual([...JOB_STATUSES].sort());
  });
});

describe("the words of a search", () => {
  it("lower case, split on spaces, and nothing a filter reads as its own grammar gets through", () => {
    expect(findWords("  41 Larkspur  ")).toEqual(["41", "larkspur"]);
    expect(findWords("12 Elm St.")).toEqual(["12", "elm", "st"]);
    // A typed line can never close a filter or open another: comma, brackets, wildcards, quotes, backslash, dot, colon.
    expect(findWords('a,b) or(c%d*e"f\\g.h:i')).toEqual(["a", "b", "or", "c", "d", "e", "f", "g", "h", "i"].slice(0, 6));
    for (const w of findWords('x,y(z)%*"\\.:')) expect(w).not.toMatch(/[,()%*"\\.:]/);
    expect(findWords("")).toEqual([]);
    expect(findWords(null)).toEqual([]);
    // Bounded: six words, forty characters each.
    expect(findWords("a b c d e f g h")).toHaveLength(6);
    expect(findWords("x".repeat(90))[0]).toHaveLength(40);
  });

  it("the database is asked for ONE word: the longest, the first of equals, and none when nothing is long enough", () => {
    expect(likeWord(["41", "larkspur"])).toBe("larkspur");
    expect(likeWord(["dana", "rook"])).toBe("dana");
    expect(likeWord(["5"])).toBeNull();
    expect(likeWord([])).toBeNull();
    expect(FIND_MIN_CHARS).toBe(2);
  });
});

describe("the every-word match", () => {
  it("every word, anywhere in the parts; no words is everything", () => {
    expect(saysEvery(["41 Larkspur Ln", "Dana Rook"], ["rook", "41"])).toBe(true);
    expect(saysEvery(["41 Larkspur Ln", "Dana Rook"], ["rook", "42"])).toBe(false);
    expect(saysEvery([null, undefined, ""], [])).toBe(true);
    // The same characters are taken out of what is searched, so "st" finds "St." and "ca" finds "Truckee, CA".
    expect(saysEvery(["12 Elm St."], findWords("elm st."))).toBe(true);
  });

  it("a finished job is found by its name, street, unit, town, number and who it was for", () => {
    const ids = (q: string) => past.filter((j) => pastJobSays(j, findWords(q))).map((j) => j.id);
    expect(ids("larkspur")).toEqual(["p1"]);
    expect(ids("rook")).toEqual(["p1"]);
    expect(ids("j-050")).toEqual(["p2"]);
    expect(ids("truckee")).toEqual(["p1", "p2"]);
    expect(ids("snowbell tillery")).toEqual(["p2"]);
    expect(ids("snowbell rook")).toEqual([]);
  });

  it("a customer is found by the name, the company, the street and the town", () => {
    const ids = (q: string) => people.filter((c) => customerSays(c, findWords(q))).map((c) => c.id);
    expect(ids("dana")).toEqual(["c1"]);
    expect(ids("bayberry")).toEqual(["c1"]);
    expect(ids("catbird")).toEqual(["c2"]);
    expect(ids("kings beach")).toEqual(["c2"]);
    expect(ids("dana catbird")).toEqual([]);
  });
});

describe("what is listed", () => {
  it("cut to its cap, and how many were left off is known, never dropped in silence", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `j${i}` }));
    expect(capFound(many, () => true, FIND_PAST_CAP)).toEqual({ rows: many.slice(0, 12), more: 18 });
    expect(capFound(many, (r) => r.id === "j3", FIND_CUSTOMER_CAP)).toEqual({ rows: [{ id: "j3" }], more: 0 });
    expect(FIND_PAST_CAP).toBe(12);
    expect(FIND_CUSTOMER_CAP).toBe(8);
  });

  it("two reads make one list, each job once, the first read's order kept", () => {
    expect(mergeById([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(mergeById([], [])).toEqual([]);
  });

  it("a place in a sentence: the street and its unit, once; nothing with no street", () => {
    expect(placeWords({ address: "41 Larkspur Ln", unit: "5" })).toBe("41 Larkspur Ln #5");
    expect(placeWords({ address: "41 Larkspur Ln", unit: "#5" })).toBe("41 Larkspur Ln #5");
    expect(placeWords({ address: "12 Snowbell Rd, Truckee, CA 96161", unit: null })).toBe("12 Snowbell Rd");
    expect(placeWords({ address: null, unit: "5" })).toBe("");
    // A unit that is only a letter or a digit found inside the street is still said ("B" in Bayberry, "1" in 41).
    expect(placeWords({ address: "9 Bayberry Ct", unit: "B" })).toBe("9 Bayberry Ct #B");
    expect(placeWords({ address: "41 Larkspur Ln", unit: "1" })).toBe("41 Larkspur Ln #1");
    // Never twice: the street line already carries it.
    expect(placeWords({ address: "12 Elm St Apt 5", unit: "Apt 5" })).toBe("12 Elm St Apt 5");
  });

  it("the line under a finished job: its street unless its name is the street, and who unless its name says who", () => {
    expect(pastJobLine(past[0])).toBe("Dana Rook");
    expect(pastJobLine(past[1])).toBe("12 Snowbell Rd · Sam Tillery");
    expect(pastJobLine(past[2])).toBe("");
  });

  it("the line under a customer: the company, the street with its unit, the town", () => {
    expect(customerLine(people[0])).toBe("9 Bayberry Ct #B · Truckee");
    expect(customerLine(people[1])).toBe("Catbird Builders · Kings Beach");
  });
});
