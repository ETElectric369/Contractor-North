import { describe, it, expect, vi, afterEach } from "vitest";
import type { DraftLineItem, TaskDetail } from "@/lib/estimate/line-map";
import {
  COULD_NOT_REACH,
  LINE_GONE,
  LINE_WAS_GONE,
  NAME_THE_LINE,
  READ_BACK_FAILED,
  STILL_SAVING,
  WAITING_READ_BACK,
  WRITE_TIMEOUT_MS,
  createQuoteSession,
  firstSavePayload,
  idsBySortOrder,
  isQuiet,
  repricedLines,
  savesAtMount,
  settle,
  substantive,
  withRefusal,
  type EstimateHeader,
  type SessionActions,
} from "./use-quote-writes";

/**
 * THE ONE SAVE MODEL, DRIVEN (cn-v1132). The parked attempt shipped on a green gate; this wave's
 * lesson is that the write path must be DRIVEN through failure → recovery. Every case here calls the
 * session with fake actions and reads what it asked the server for, what it keeps on the row, and
 * what it says beside it. No DOM: the React hook only subscribes to this.
 */

const CLIENT = "11111111-1111-4111-8111-111111111111";
const header: EstimateHeader = {
  customerId: "",
  leadId: "",
  jobId: null,
  captureId: null,
  docType: "estimate",
  estimateFormat: null,
  title: "",
  description: "",
  notes: "",
  taxRate: 0,
  validUntil: "2026-11-26",
};
const rule = { label: null, person_id: null, hours: 2, rate: 145, rate_from: "rule" as const };
const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({ task_id: "t1", labor: [rule], units: null, kit_id: null, materials: [], ...over });
const trench: DraftLineItem = { description: "Trench", quantity: 1, unit: "ea", unit_price: 290 };
const task: DraftLineItem = { description: "Install transfer switch", quantity: 1, unit: "ea", unit_price: 290, group: "Tasks", detail: detail() };
const blank: DraftLineItem = { description: "", quantity: 1, unit: "ea", unit_price: 0 };

/** Fake actions that LAND, each recorded; a test overrides the one it wants to refuse or throw. The
 *  read-back answers with the lines the first save was asked to write — ids li-1…, each at its index,
 *  saying what the line says — as the real read does (readQuoteLineIds returns the description). */
function fakes(over: Partial<SessionActions> = {}) {
  // Off the mock's own record, so a test that hands in its own saveQuote (a gate, a refusal first) is
  // read back the same way.
  const wrote = (): DraftLineItem[] => (calls(a.saveQuote).at(-1)?.[0] as { items?: DraftLineItem[] } | undefined)?.items ?? [];
  const a: SessionActions = {
    saveQuote: vi.fn(async (input) => ({ ok: true as const, id: input.id, quote_number: "E-012" })),
    appendQuoteLines: vi.fn(async (_q: string, lines: (DraftLineItem & { id: string })[]) => ({ ok: true as const, ids: lines.map((l) => l.id) })),
    updateQuoteItem: vi.fn(async () => ({ ok: true })),
    deleteQuoteItem: vi.fn(async () => ({ ok: true })),
    updateQuoteMeta: vi.fn(async () => ({ ok: true })),
    setQuoteCustomer: vi.fn(async () => ({ ok: true })),
    setQuoteType: vi.fn(async () => ({ ok: true })),
    readQuoteLineIds: vi.fn(async () => ({ ok: true as const, items: wrote().map((l, i) => ({ id: `li-${i + 1}`, sort_order: i, description: l.description })) })),
    ...over,
  };
  return { a };
}
let n = 0;
const keys = () => `k${++n}`;
let idN = 0;
const ids = () => `id-${++idN}`;
const unsaved = (items: DraftLineItem[], over: Partial<SessionActions> = {}, clientId = CLIENT, seed: EstimateHeader = header) => {
  const f = fakes(over);
  const s = createQuoteSession({ mode: { kind: "unsaved", clientId }, header: seed, items, actions: f.a, newKey: keys, newId: ids });
  return { s, ...f };
};
const saved = (items: (DraftLineItem & { id: string })[], over: Partial<SessionActions> = {}, status = "draft") => {
  const f = fakes(over);
  const s = createQuoteSession({ mode: { kind: "saved", id: "q1", number: "E-001", status, bornHere: false }, header, items, actions: f.a, newKey: keys, newId: ids });
  return { s, ...f };
};
/** A promise a test releases by hand: the write on the wire. */
function gate<T>() {
  let release: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (release = r));
  return { promise, release };
}
const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls;

afterEach(() => {
  vi.useRealTimers();
});

describe("settle — what a write's answer means", () => {
  it("ok keeps the value; a refusal is the server's words, the fallback when it gave none; a throw is the one unreachable line", async () => {
    expect(await settle(async () => ({ ok: true, id: "x" }), "fb")).toEqual({ landed: true, value: { ok: true, id: "x" } });
    expect(await settle(async () => ({ ok: false, error: "That line isn't on this estimate." }), "fb")).toEqual({ landed: false, words: "That line isn't on this estimate." });
    expect(await settle(async () => ({ ok: false }), "fb")).toEqual({ landed: false, words: "fb" });
    expect(await settle(async () => null, "fb")).toEqual({ landed: false, words: "fb" });
    expect(await settle(async () => { throw new Error("fetch failed"); }, "fb")).toEqual({ landed: false, words: COULD_NOT_REACH });
    expect(COULD_NOT_REACH).toBe("Couldn't reach the server — press Retry");
  });
  it("a call that answers nothing inside the clock reads as unreachable (twenty seconds), with Retry; the clock is cleared on an answer", async () => {
    vi.useFakeTimers();
    expect(WRITE_TIMEOUT_MS).toBe(20_000);
    const hung = settle(() => new Promise<{ ok: boolean }>(() => {}), "fb");
    await vi.advanceTimersByTimeAsync(19_999);
    let done = false;
    void hung.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await hung).toEqual({ landed: false, words: COULD_NOT_REACH });
    // An answer inside the clock: the timer goes with it (nothing left pending on the loop).
    expect(await settle(async () => ({ ok: true }), "fb")).toEqual({ landed: true, value: { ok: true } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("withRefusal sets, replaces and clears one slot without touching the others", () => {
    const a = withRefusal({}, "line:k1", "no");
    expect(withRefusal(a, "line:k2", "nope")).toEqual({ "line:k1": "no", "line:k2": "nope" });
    expect(withRefusal(a, "line:k1", "still no")).toEqual({ "line:k1": "still no" });
    expect(withRefusal(a, "line:k1", null)).toEqual({});
    expect(withRefusal(a, "line:k9", null)).toBe(a);
  });
});

describe("a refused line write", () => {
  it("keeps the figure on its row, shows the words with Retry; Retry lands it and clears them; the next write goes through", async () => {
    const { s, a } = saved([{ ...trench, id: "li-1" }], {
      updateQuoteItem: vi.fn().mockResolvedValueOnce({ ok: false, error: "That line isn't on this estimate." }).mockResolvedValue({ ok: true }),
    });
    const key = s.get().items[0].key;
    s.typeLine(key, { unit_price: 310 });
    expect(await s.commitLine(key)).toBe(false);
    // The typed figure stands on the row; the words sit on the slot; nothing is pending.
    expect(s.get().items[0].unit_price).toBe(310);
    expect(s.get().refusals).toEqual({ [`line:${key}`]: "That line isn't on this estimate." });
    expect(s.get().pending).toBeNull();
    // A second blur with nothing changed sends nothing (only Retry or a later edit does).
    expect(await s.commitLine(key)).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(1);
    // Retry runs the SAME write again: the same id, the same patch.
    expect(await s.retry(`line:${key}`)).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(2);
    expect(a.updateQuoteItem).toHaveBeenLastCalledWith("li-1", "q1", { description: "Trench", quantity: 1, unit: "ea", unit_price: 310, category: null });
    expect(s.get().refusals).toEqual({});
    // The next write goes through on its own.
    s.typeLine(key, { quantity: 2 });
    expect(await s.commitLine(key)).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(3);
    expect(calls(a.updateQuoteItem)[2][2]).toMatchObject({ quantity: 2, unit_price: 310 });
  });

  it("a thrown action reads 'Couldn't reach the server — press Retry'", async () => {
    const { s } = saved([{ ...trench, id: "li-1" }], { updateQuoteItem: vi.fn().mockRejectedValue(new Error("fetch failed")) });
    const key = s.get().items[0].key;
    s.typeLine(key, { description: "Trench, 40 ft" });
    await s.commitLine(key);
    expect(s.get().refusals[`line:${key}`]).toBe(COULD_NOT_REACH);
    expect(s.get().items[0].description).toBe("Trench, 40 ft");
  });

  it("a write that hangs reads as unreachable after the clock, the controls come back, and Retry runs it again", async () => {
    vi.useFakeTimers();
    const { s, a } = saved([{ ...trench, id: "li-1" }], { updateQuoteItem: vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue({ ok: true }) });
    const key = s.get().items[0].key;
    s.typeLine(key, { unit_price: 300 });
    const hung = s.commitLine(key);
    expect(s.get().pending).toBe(`line:${key}`);
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    expect(await hung).toBe(false);
    expect(s.get().pending).toBeNull();
    expect(s.get().refusals[`line:${key}`]).toBe(COULD_NOT_REACH);
    expect(await s.retry(`line:${key}`)).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(2);
    expect(s.get().refusals).toEqual({});
  });

  it("a later edit of the same field replaces the pending retry; nothing else waits behind a refusal", async () => {
    const { s, a } = saved([{ ...trench, id: "li-1" }, { ...task, id: "li-2" }], {
      updateQuoteItem: vi.fn().mockResolvedValueOnce({ ok: false, error: "no" }).mockResolvedValue({ ok: true }),
    });
    const [k1, k2] = s.get().items.map((l) => l.key);
    s.typeLine(k1, { unit_price: 300 });
    await s.commitLine(k1); // refused
    // Another row writes at once — a refusal holds nobody up.
    s.typeLine(k2, { quantity: 2 });
    expect(await s.commitLine(k2)).toBe(true);
    expect(s.get().refusals).toEqual({ [`line:${k1}`]: "no" });
    // He edits the refused row again: the new write replaces the retry, and lands.
    s.typeLine(k1, { unit_price: 320 });
    expect(await s.commitLine(k1)).toBe(true);
    expect(s.get().refusals).toEqual({});
    expect(calls(a.updateQuoteItem).at(-1)?.[2]).toMatchObject({ unit_price: 320 });
    // Retry on a slot that landed is a no-op.
    expect(await s.retry(`line:${k1}`)).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(3);
  });

  it("one write in flight: a commit asked for while one runs is QUEUED — said on its row in words with no Retry, never dropped — and goes on its own when the wire is free", async () => {
    const g = gate<{ ok: boolean }>();
    const { s, a } = saved([{ ...trench, id: "li-1" }, { ...task, id: "li-2" }], { updateQuoteItem: vi.fn().mockReturnValueOnce(g.promise).mockResolvedValue({ ok: true }) });
    const [k1, k2] = s.get().items.map((l) => l.key);
    s.typeLine(k1, { unit_price: 300 });
    const first = s.commitLine(k1);
    expect(s.get().pending).toBe(`line:${k1}`);
    s.typeLine(k2, { quantity: 3 });
    expect(await s.commitLine(k2)).toBe(false);
    expect(s.get().waiting[`line:${k2}`]).toBe(STILL_SAVING);
    expect(s.get().refusals).toEqual({});
    expect(STILL_SAVING).not.toMatch(/Retry/);
    // Retry while the wire is busy does nothing (the buttons are disabled anyway).
    expect(await s.retry(`line:${k2}`)).toBe(false);
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(1);
    g.release({ ok: true });
    expect(await first).toBe(true);
    // The queued write went by itself, once, with the figure as committed.
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(2);
    expect(calls(a.updateQuoteItem)[1]).toEqual(["li-2", "q1", expect.objectContaining({ quantity: 3 })]);
    expect(s.get().pending).toBeNull();
    expect(s.get().waiting).toEqual({});
    expect(s.get().refusals).toEqual({});
  });
});

describe("the task breakdown writes through updateQuoteItem with the detail and the group", () => {
  it("hours typed on a task → the whole line: unit_price, detail, description, quantity, unit, category", async () => {
    const { s, a } = saved([{ ...task, id: "li-2" }]);
    const key = s.get().items[0].key;
    const next: DraftLineItem = { ...task, unit_price: 435, detail: detail({ labor: [{ ...rule, hours: 3 }] }) };
    expect(await s.commitLine(key, next)).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledWith("li-2", "q1", {
      description: "Install transfer switch",
      quantity: 1,
      unit: "ea",
      unit_price: 435,
      category: "Tasks",
      detail: expect.objectContaining({ task_id: "t1", labor: [expect.objectContaining({ hours: 3, rate: 145 })] }),
    });
    expect(s.get().items[0].unit_price).toBe(435);
  });
  it("what the job's list did rides the line (said / note), and a removed line's under the list", async () => {
    const { s } = saved([{ ...task, id: "li-2" }, { ...trench, id: "li-1" }], {
      updateQuoteItem: vi.fn(async () => ({ ok: true, said: "The job's task is renamed too." })),
      deleteQuoteItem: vi.fn(async () => ({ ok: true, said: "The job's task went with it." })),
    });
    const [k1, k2] = s.get().items.map((l) => l.key);
    await s.commitLine(k1, { ...task, description: "Install the transfer switch" });
    expect(s.get().follow[k1]).toEqual({ said: "The job's task is renamed too." });
    expect(await s.removeLine(k2)).toBe(true);
    expect(s.get().items.map((l) => l.key)).toEqual([k1]);
    expect(s.get().said).toBe("The job's task went with it.");
  });
  it("a refused delete keeps the line with the words and Retry", async () => {
    const { s, a } = saved([{ ...trench, id: "li-1" }], { deleteQuoteItem: vi.fn().mockResolvedValueOnce({ ok: false, error: "locked" }).mockResolvedValue({ ok: true }) });
    const key = s.get().items[0].key;
    expect(await s.removeLine(key)).toBe(false);
    expect(s.get().items.length).toBe(1);
    expect(s.get().refusals[`delete:${key}`]).toBe("locked");
    expect(await s.retry(`delete:${key}`)).toBe(true);
    expect(s.get().items.length).toBe(0);
    expect(a.deleteQuoteItem).toHaveBeenCalledTimes(2);
  });
  it("a delete whose answer was lost: Retry is answered 'isn't on this estimate' — the line is gone, said under the list, no loop", async () => {
    const { s, a } = saved([{ ...trench, id: "li-1" }, { ...task, id: "li-2" }], {
      deleteQuoteItem: vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValue({ ok: false, error: LINE_GONE }),
    });
    const [k1, k2] = s.get().items.map((l) => l.key);
    expect(await s.removeLine(k1)).toBe(false);
    expect(s.get().refusals[`delete:${k1}`]).toBe(COULD_NOT_REACH);
    expect(s.get().items.length).toBe(2);
    expect(await s.retry(`delete:${k1}`)).toBe(true);
    expect(a.deleteQuoteItem).toHaveBeenCalledTimes(2);
    expect(s.get().items.map((l) => l.key)).toEqual([k2]);
    expect(s.get().refusals).toEqual({});
    expect(s.get().said).toBe(LINE_WAS_GONE);
    expect(LINE_GONE).toBe("That line isn't on this estimate.");
  });
});

describe("a new line on a saved estimate", () => {
  it("is held until it has a description (said once it has a figure), then appended ONCE under its own id with its group and detail; edits after that are its own writes", async () => {
    const { s, a } = saved([{ ...trench, id: "li-1" }]);
    const d = detail({ labor: [{ ...rule, hours: null }] });
    const key = s.addLine({ description: "", quantity: 1, unit: "ea", unit_price: 0, group: "Tasks", detail: d });
    expect(s.get().items[1]).toMatchObject({ id: null, saved: false });
    // Blank and untouched: nothing is said, nothing is sent.
    await s.commitLine(key);
    expect(a.appendQuoteLines).not.toHaveBeenCalled();
    expect(s.get().waiting).toEqual({});
    // Hours typed before a name: asked for the name, still not sent.
    await s.commitLine(key, { ...s.get().items[1], unit_price: 290, detail: detail() });
    expect(s.get().waiting[`line:${key}`]).toBe(NAME_THE_LINE);
    expect(a.appendQuoteLines).not.toHaveBeenCalled();
    // Named: one append, group and detail intact, under an id the editor chose at the append.
    s.typeLine(key, { description: "Install transfer switch" });
    expect(await s.commitLine(key)).toBe(true);
    const own = s.get().items[1].id as string;
    expect(own).toMatch(/^id-\d+$/);
    expect(a.appendQuoteLines).toHaveBeenCalledTimes(1);
    expect(a.appendQuoteLines).toHaveBeenCalledWith("q1", [{ description: "Install transfer switch", quantity: 1, unit: "ea", unit_price: 290, group: "Tasks", detail: detail(), id: own }]);
    expect(s.get().items[1]).toMatchObject({ id: own, saved: true });
    expect(s.get().waiting).toEqual({});
    // From here it writes on its own.
    s.typeLine(key, { quantity: 2 });
    await s.commitLine(key);
    expect(a.updateQuoteItem).toHaveBeenCalledWith(own, "q1", expect.objectContaining({ quantity: 2 }));
  });

  it("a kit pick is ONE append with every line's group and detail intact; a refusal keeps the lines on the estimate with Retry, which sends the SAME ids", async () => {
    const kit: DraftLineItem[] = [
      { description: "Concrete, 60 lb", quantity: 4, unit: "bag", unit_price: 8, group: "Footing" },
      { description: "Rebar — #4", quantity: 2, unit: "ea", unit_price: 5, group: "Footing" },
    ];
    const { s, a } = saved([{ ...trench, id: "li-1" }], {
      appendQuoteLines: vi.fn().mockResolvedValueOnce({ ok: false, error: "These line items are locked" }).mockImplementation(async (_q: string, lines: { id: string }[]) => ({ ok: true, ids: lines.map((l) => l.id) })),
    });
    expect(await s.addLines(kit)).toBe(false);
    const sent = calls(a.appendQuoteLines)[0][1] as (DraftLineItem & { id: string })[];
    expect(sent.map(({ id: _id, ...l }) => l)).toEqual(kit);
    // On the estimate, unsaved, with the words beside the list.
    expect(s.get().items.map((l) => [l.description, l.group, l.saved])).toEqual([["Trench", undefined, true], ["Concrete, 60 lb", "Footing", false], ["Rebar — #4", "Footing", false]]);
    const slot = Object.keys(s.get().refusals).find((k) => k.startsWith("append:"))!;
    expect(s.get().refusals[slot]).toBe("These line items are locked");
    expect(await s.retry(slot)).toBe(true);
    expect(calls(a.appendQuoteLines)[1][1]).toEqual(sent);
    expect(s.get().items.slice(1).map((l) => [l.id, l.saved])).toEqual(sent.map((l) => [l.id, true]));
    expect(s.get().refusals).toEqual({});
  });

  it("an append whose answer was lost: Retry re-sends the same ids and the server holds exactly one row per line", async () => {
    const rows = new Map<string, DraftLineItem>();
    let lost = true;
    const appendQuoteLines = vi.fn(async (_q: string, lines: (DraftLineItem & { id: string })[]) => {
      for (const l of lines) rows.set(l.id, l); // the insert landed …
      if (lost) {
        lost = false;
        throw new Error("the answer was lost"); // … and its answer did not come back
      }
      return { ok: true as const, ids: lines.map((l) => l.id) };
    });
    const { s, a } = saved([{ ...trench, id: "li-1" }], { appendQuoteLines });
    expect(await s.addLines([task, { ...trench, description: "Backfill" }])).toBe(false);
    const slot = Object.keys(s.get().refusals)[0];
    expect(s.get().refusals[slot]).toBe(COULD_NOT_REACH);
    expect(await s.retry(slot)).toBe(true);
    expect(a.appendQuoteLines).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(2);
    expect(s.get().items.slice(1).every((l) => l.saved && l.id && rows.has(l.id))).toBe(true);
  });

  it("a line removed while its own append is on the wire is on the server by the landing: deleted after it, never dropped into an orphan row", async () => {
    const g = gate<{ ok: true; ids: string[] }>();
    const { s, a } = saved([{ ...trench, id: "li-1" }], { appendQuoteLines: vi.fn().mockReturnValueOnce(g.promise) });
    const append = s.addLines([task]);
    const key = s.get().items[1].key;
    const own = s.get().items[1].id as string;
    expect(await s.removeLine(key)).toBe(false);
    expect(s.get().items.length).toBe(2);
    g.release({ ok: true, ids: [own] });
    expect(await append).toBe(true);
    expect(a.deleteQuoteItem).toHaveBeenCalledWith(own, "q1");
    expect(s.get().items.map((l) => l.id)).toEqual(["li-1"]);
    expect(s.get().waiting).toEqual({});
  });

  it("a task line through the kit door keeps its detail on the wire", async () => {
    const { s, a } = saved([]);
    await s.addLines([task]);
    expect(calls(a.appendQuoteLines)[0][1]).toEqual([{ ...task, id: expect.stringMatching(/^id-/) }]);
  });
});

describe("the header on a saved estimate", () => {
  it("each field is its own write, only when it changed; a refusal keeps the typed value with Retry", async () => {
    const { s, a } = saved([], { updateQuoteMeta: vi.fn().mockResolvedValueOnce({ ok: false, error: "That estimate isn't here to update." }).mockResolvedValue({ ok: true }) });
    await s.commitHeader("title"); // unchanged: nothing sent
    expect(a.updateQuoteMeta).not.toHaveBeenCalled();
    s.typeHeader({ title: "Larkspur panel" });
    expect(await s.commitHeader("title")).toBe(false);
    expect(s.get().header.title).toBe("Larkspur panel");
    expect(s.get().refusals["header:title"]).toBe("That estimate isn't here to update.");
    // A second blur on the same words sends nothing; Retry does.
    expect(await s.commitHeader("title")).toBe(true);
    expect(a.updateQuoteMeta).toHaveBeenCalledTimes(1);
    expect(await s.retry("header:title")).toBe(true);
    expect(a.updateQuoteMeta).toHaveBeenLastCalledWith("q1", { title: "Larkspur panel" });
    s.typeHeader({ taxRate: 0.0825, validUntil: "", notes: "Net 30", estimateFormat: "detailed", description: "The scope." });
    await s.commitHeader("taxRate");
    await s.commitHeader("validUntil");
    await s.commitHeader("notes");
    await s.commitHeader("estimateFormat");
    await s.commitHeader("description");
    expect(calls(a.updateQuoteMeta).slice(2).map((c) => c[1])).toEqual([{ tax_rate: 0.0825 }, { valid_until: null }, { notes: "Net 30" }, { estimate_format: "detailed" }, { description: "The scope." }]);
    s.typeHeader({ customerId: "c1", docType: "quote" });
    await s.commitHeader("customerId");
    await s.commitHeader("docType");
    expect(a.setQuoteCustomer).toHaveBeenCalledWith("q1", "c1");
    expect(a.setQuoteType).toHaveBeenCalledWith("q1", "quote");
    // The lead is provenance once the row exists: no door, no write.
    s.typeHeader({ leadId: "lead-2" });
    expect(await s.commitHeader("leadId")).toBe(true);
    expect(a.updateQuoteMeta).toHaveBeenCalledTimes(7);
  });
});

describe("birth without litter", () => {
  it("a cold open calls nothing; the first commit saves ONCE under the client's id, the ids are read back, the session is quiet, and the next write is per line", async () => {
    const { s, a } = unsaved([blank]);
    expect(savesAtMount(s.get().items)).toBe(false);
    await s.mount();
    expect(a.saveQuote).not.toHaveBeenCalled();
    const key = s.get().items[0].key;
    s.typeLine(key, { description: "Trench", unit_price: 290 });
    expect(await s.commitLine(key)).toBe(true);
    expect(a.saveQuote).toHaveBeenCalledTimes(1);
    expect(a.saveQuote).toHaveBeenCalledWith({
      id: CLIENT,
      customer_id: null,
      job_id: null,
      inquiry_id: null,
      capture_appointment_id: null,
      title: "",
      description: "",
      notes: "",
      tax_rate: 0,
      valid_until: "2026-11-26",
      doc_type: "estimate",
      estimate_format: null,
      items: [{ description: "Trench", quantity: 1, unit: "ea", unit_price: 290 }],
    });
    expect(s.get().mode).toEqual({ kind: "saved", id: CLIENT, number: "E-012", status: "draft", bornHere: true });
    expect(a.readQuoteLineIds).toHaveBeenCalledWith(CLIENT);
    expect(s.get().items[0]).toMatchObject({ id: "li-1", saved: true });
    expect(isQuiet(s.get())).toBe(true);
    // Every later write is its own.
    s.typeLine(key, { quantity: 2 });
    await s.commitLine(key);
    expect(a.saveQuote).toHaveBeenCalledTimes(1);
    expect(a.updateQuoteItem).toHaveBeenCalledWith("li-1", CLIENT, expect.objectContaining({ quantity: 2 }));
    s.typeHeader({ title: "Larkspur panel" });
    await s.commitHeader("title");
    expect(a.updateQuoteMeta).toHaveBeenCalledWith(CLIENT, { title: "Larkspur panel" });
  });

  it("the seed with real lines saves exactly once at mount, and a second mount (strict mode) does not save again", async () => {
    const { s, a } = unsaved([task, trench]);
    expect(savesAtMount(s.get().items)).toBe(true);
    await Promise.all([s.mount(), s.mount()]);
    expect(a.saveQuote).toHaveBeenCalledTimes(1);
    expect(calls(a.saveQuote)[0][0].items).toEqual([task, trench]);
    expect(s.get().mode.kind).toBe("saved");
    expect(s.get().refusals).toEqual({});
    expect(s.get().items.map((l) => l.id)).toEqual(["li-1", "li-2"]);
    await s.mount(); // saved: nothing more
    expect(a.saveQuote).toHaveBeenCalledTimes(1);
  });

  it("a refused first save leaves an unsaved editor whose Retry calls saveQuote again with the SAME id and the estimate as it stands", async () => {
    const { s, a } = unsaved([trench], { saveQuote: vi.fn().mockResolvedValueOnce({ ok: false, error: "Couldn't save." }).mockResolvedValue({ ok: true, id: CLIENT, quote_number: "E-013" }) });
    await s.mount();
    expect(s.get().mode.kind).toBe("unsaved");
    expect(s.get().refusals["first-save"]).toBe("Couldn't save.");
    expect(isQuiet(s.get())).toBe(false);
    // A blur that changed nothing re-sends nothing; typing between the refusal and Retry rides the retry.
    const key = s.get().items[0].key;
    expect(await s.commitLine(key)).toBe(true);
    expect(a.saveQuote).toHaveBeenCalledTimes(1);
    s.typeHeader({ title: "Larkspur panel" });
    expect(await s.retry("first-save")).toBe(true);
    expect(a.saveQuote).toHaveBeenCalledTimes(2);
    const [first, second] = calls(a.saveQuote).map((c) => c[0]);
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Larkspur panel");
    expect(s.get().mode).toMatchObject({ kind: "saved", number: "E-013", bornHere: true });
  });

  it("a thrown first save reads the unreachable line, and a later edit replaces the retry with a fresh save", async () => {
    const { s, a } = unsaved([trench], { saveQuote: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true, id: CLIENT }) });
    await s.mount();
    expect(s.get().refusals["first-save"]).toBe(COULD_NOT_REACH);
    s.typeHeader({ notes: "Net 30" });
    expect(await s.commitHeader("notes")).toBe(true);
    expect(a.saveQuote).toHaveBeenCalledTimes(2);
    expect(s.get().refusals).toEqual({});
  });

  it("a kit picked on an unsaved estimate IS the first save (every line in it, group and detail intact); the proposals it came from are not sent twice", async () => {
    const { s, a } = unsaved([blank]);
    expect(await s.addLines([task, { ...trench, group: "Footing" }])).toBe(true);
    expect(a.saveQuote).toHaveBeenCalledTimes(1);
    expect(calls(a.saveQuote)[0][0].items).toEqual([task, { ...trench, group: "Footing" }]);
    expect(a.appendQuoteLines).not.toHaveBeenCalled();
    expect(s.get().items.map((l) => l.id)).toEqual(["li-1", "li-2"]);
  });

  it("when the ids cannot be read back, the row is saved and says so; a line edit waits on Retry rather than appending a twin, and goes once the read-back lands", async () => {
    const { s, a } = unsaved([trench], { readQuoteLineIds: vi.fn().mockResolvedValueOnce({ ok: false, error: "no" }).mockResolvedValue({ ok: true, items: [{ id: "li-1", sort_order: 0, description: "Trench" }] }) });
    await s.mount();
    expect(s.get().mode.kind).toBe("saved");
    expect(s.get().refusals["read-back"]).toBe(READ_BACK_FAILED);
    const key = s.get().items[0].key;
    s.typeLine(key, { quantity: 2 });
    expect(await s.commitLine(key)).toBe(false);
    expect(a.appendQuoteLines).not.toHaveBeenCalled();
    expect(a.updateQuoteItem).not.toHaveBeenCalled();
    expect(s.get().waiting[`line:${key}`]).toBe(WAITING_READ_BACK);
    expect(isQuiet(s.get())).toBe(false);
    // The read-back lands: the id is on the row, the waiting words go, and the edit he made meanwhile
    // is written at once (nothing typed is left unsaved in silence).
    expect(await s.retry("read-back")).toBe(true);
    expect(s.get().items[0].id).toBe("li-1");
    expect(s.get().waiting).toEqual({});
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(1);
    expect(a.updateQuoteItem).toHaveBeenCalledWith("li-1", CLIENT, expect.objectContaining({ quantity: 2 }));
    expect(await s.commitLine(key)).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(1);
    expect(isQuiet(s.get())).toBe(true);
  });

  it("firstSavePayload always carries the paper format (null is the choice as it stands) and only the named lines; idsBySortOrder matches the first save's lines only", () => {
    const p = firstSavePayload("id-1", { ...header, estimateFormat: "detailed", customerId: "c1", leadId: "l1", jobId: "j1", captureId: "a1" }, [trench, { description: " ", quantity: 1, unit: "ea", unit_price: 0 }]);
    expect(p).toMatchObject({ id: "id-1", estimate_format: "detailed", customer_id: "c1", inquiry_id: "l1", job_id: "j1", capture_appointment_id: "a1", items: [trench] });
    expect(firstSavePayload("id-1", header, [])).toMatchObject({ estimate_format: null, items: [] });
    // Two lines the first save wrote, read back out of order; a line appended under its own id meanwhile
    // (known) is neither re-matched nor allowed to shift the others.
    const items = [
      { ...trench, key: "a", id: null, saved: true },
      { ...task, key: "c", id: "own-9", saved: true },
      { ...task, key: "b", id: null, saved: true },
    ];
    expect(
      idsBySortOrder(items, [
        { id: "two", sort_order: 1, description: task.description },
        { id: "own-9", sort_order: 2, description: task.description },
        { id: "one", sort_order: 0, description: "Trench" },
      ]).map((l) => l.id),
    ).toEqual(["one", "own-9", "two"]);
  });
});

describe("the read-back's rows are matched by what they say (S6)", () => {
  const two = [
    { ...trench, key: "a", id: null, saved: true },
    { ...task, key: "b", id: null, saved: true },
  ];
  it("an extra row ahead of the lines does not shift the ids onto the wrong rows; the row that says what the line says is its", () => {
    const read = [
      { id: "x", sort_order: 0, description: "Something else" },
      { id: "one", sort_order: 1, description: "Trench" },
      { id: "two", sort_order: 2, description: "Install transfer switch" },
    ];
    expect(idsBySortOrder(two, read).map((l) => l.id)).toEqual(["one", "two"]);
  });
  it("two rows tied at one place: each line takes the one that says its words", () => {
    const read = [
      { id: "b-row", sort_order: 0, description: "Install transfer switch" },
      { id: "a-row", sort_order: 0, description: "Trench" },
    ];
    expect(idsBySortOrder(two, read).map((l) => l.id)).toEqual(["a-row", "b-row"]);
  });
  it("two lines with the same words keep their order: the row at the line's place first, else the earliest unused", () => {
    const same = [
      { ...trench, key: "a", id: null, saved: true },
      { ...trench, key: "b", id: null, saved: true },
    ];
    expect(idsBySortOrder(same, [{ id: "second", sort_order: 1, description: "Trench" }, { id: "first", sort_order: 0, description: "Trench" }]).map((l) => l.id)).toEqual(["first", "second"]);
    expect(idsBySortOrder(same, [{ id: "p", sort_order: 5, description: "  Trench " }, { id: "q", sort_order: 7, description: "Trench" }]).map((l) => l.id)).toEqual(["p", "q"]);
  });
  it("a row at a line's place that says something else is NOT its id (the next edit would overwrite a stranger); fewer rows than lines leaves the rest without one", () => {
    expect(idsBySortOrder(two, [{ id: "x", sort_order: 0, description: "Backfill" }, { id: "y", sort_order: 1, description: "Backfill" }]).map((l) => l.id)).toEqual([null, null]);
    expect(idsBySortOrder(two, [{ id: "one", sort_order: 0, description: "Trench" }]).map((l) => l.id)).toEqual(["one", null]);
    // A row with no words vouches for nothing.
    expect(idsBySortOrder(two, [{ id: "one", sort_order: 0 }, { id: "two", sort_order: 1 }]).map((l) => l.id)).toEqual([null, null]);
  });
  it("driven: a read-back that lands short says READ_BACK_FAILED with a Retry that reads again; the lines it did vouch for are editable at once", async () => {
    const { s, a } = unsaved([trench, task], {
      readQuoteLineIds: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, items: [{ id: "li-1", sort_order: 0, description: "Trench" }] })
        .mockResolvedValue({ ok: true, items: [{ id: "li-1", sort_order: 0, description: "Trench" }, { id: "li-2", sort_order: 1, description: "Install transfer switch" }] }),
    });
    await s.mount();
    expect(s.get().mode.kind).toBe("saved");
    expect(s.get().items.map((l) => l.id)).toEqual(["li-1", null]);
    expect(s.get().refusals["read-back"]).toBe(READ_BACK_FAILED);
    const [k1, k2] = s.get().items.map((l) => l.key);
    // The vouched-for line writes on its own; the other waits with its words, and nothing is appended as a twin.
    s.typeLine(k1, { quantity: 2 });
    expect(await s.commitLine(k1)).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledWith("li-1", CLIENT, expect.objectContaining({ quantity: 2 }));
    s.typeLine(k2, { quantity: 3 });
    expect(await s.commitLine(k2)).toBe(false);
    expect(s.get().waiting[`line:${k2}`]).toBe(WAITING_READ_BACK);
    expect(a.appendQuoteLines).not.toHaveBeenCalled();
    // Retry reads again: the second row vouches now, the id lands, and the edit he made goes.
    expect(await s.retry("read-back")).toBe(true);
    expect(a.readQuoteLineIds).toHaveBeenCalledTimes(2);
    expect(s.get().items.map((l) => l.id)).toEqual(["li-1", "li-2"]);
    expect(a.updateQuoteItem).toHaveBeenCalledWith("li-2", CLIENT, expect.objectContaining({ quantity: 3 }));
    expect(s.get().refusals).toEqual({});
    expect(s.get().waiting).toEqual({});
    expect(isQuiet(s.get())).toBe(true);
  });
});

describe("a line the server may hold is deleted there, never dropped (S1)", () => {
  it("after an append whose answer was lost, Remove calls deleteQuoteItem under the line's own id; the append's words go with its last line", async () => {
    const { s, a } = saved([{ ...trench, id: "li-1" }], { appendQuoteLines: vi.fn().mockRejectedValueOnce(new Error("lost")) });
    expect(await s.addLines([task])).toBe(false);
    const added = s.get().items[1];
    expect(added.saved).toBe(false);
    expect(added.id).toMatch(/^id-/);
    const slot = Object.keys(s.get().refusals)[0];
    expect(s.get().refusals[slot]).toBe(COULD_NOT_REACH);
    expect(await s.removeLine(added.key)).toBe(true);
    expect(a.deleteQuoteItem).toHaveBeenCalledWith(added.id, "q1");
    expect(s.get().items.map((l) => l.id)).toEqual(["li-1"]);
    // Nothing of that append is left to send again: its words and its Retry went with the line.
    expect(s.get().refusals).toEqual({});
    expect(await s.retry(slot)).toBe(true);
    expect(a.appendQuoteLines).toHaveBeenCalledTimes(1);
    expect(isQuiet(s.get())).toBe(true);
  });
  it("after the clock, the same — the rows may have landed, so the server is asked; 'isn't on this estimate' lands as gone", async () => {
    vi.useFakeTimers();
    const { s, a } = saved([{ ...trench, id: "li-1" }], {
      appendQuoteLines: vi.fn().mockReturnValueOnce(new Promise(() => {})),
      deleteQuoteItem: vi.fn(async () => ({ ok: false, error: LINE_GONE })),
    });
    const hung = s.addLines([task]);
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    expect(await hung).toBe(false);
    const added = s.get().items[1];
    expect(s.get().refusals[`append:${added.key}`]).toBe(COULD_NOT_REACH);
    expect(await s.removeLine(added.key)).toBe(true);
    expect(a.deleteQuoteItem).toHaveBeenCalledWith(added.id, "q1");
    expect(s.get().items.length).toBe(1);
    expect(s.get().said).toBe(LINE_WAS_GONE);
    expect(s.get().refusals).toEqual({});
  });
  it("removed while another write is on the wire: queued behind it, then deleted on the server — the queued path drops nothing with an id", async () => {
    const g = gate<{ ok: boolean }>();
    const { s, a } = saved([{ ...trench, id: "li-1" }], {
      appendQuoteLines: vi.fn().mockRejectedValueOnce(new Error("lost")),
      updateQuoteItem: vi.fn().mockReturnValueOnce(g.promise),
    });
    await s.addLines([task]);
    const [k1, k2] = s.get().items.map((l) => l.key);
    const own = s.get().items[1].id;
    s.typeLine(k1, { unit_price: 300 });
    const first = s.commitLine(k1);
    expect(await s.removeLine(k2)).toBe(false);
    expect(s.get().waiting[`line:${k2}`]).toBe(STILL_SAVING);
    expect(s.get().items.length).toBe(2);
    g.release({ ok: true });
    expect(await first).toBe(true);
    expect(a.deleteQuoteItem).toHaveBeenCalledWith(own, "q1");
    expect(s.get().items.map((l) => l.id)).toEqual(["li-1"]);
    expect(s.get().refusals).toEqual({});
    expect(s.get().waiting).toEqual({});
  });
  it("a line the server was never asked for (no id) still just goes; one of a refused append that stays keeps the append's Retry, which sends only what is still unsaved", async () => {
    const { s, a } = saved([{ ...trench, id: "li-1" }], { appendQuoteLines: vi.fn().mockResolvedValueOnce({ ok: false, error: "locked" }).mockImplementation(async (_q: string, lines: { id: string }[]) => ({ ok: true, ids: lines.map((l) => l.id) })) });
    const never = s.addLine({ ...trench, description: "Backfill" });
    expect(await s.removeLine(never)).toBe(true);
    expect(a.deleteQuoteItem).not.toHaveBeenCalled();
    await s.addLines([task, { ...trench, description: "Conduit" }]);
    const [, kTask, kConduit] = s.get().items.map((l) => l.key);
    const slot = Object.keys(s.get().refusals)[0];
    expect(await s.removeLine(kTask)).toBe(true);
    expect(a.deleteQuoteItem).toHaveBeenCalledTimes(1);
    expect(s.get().refusals[slot]).toBe("locked"); // Conduit is still unsaved: the Retry stands
    expect(await s.retry(slot)).toBe(true);
    expect((calls(a.appendQuoteLines)[1][1] as { description: string }[]).map((l) => l.description)).toEqual(["Conduit"]);
    expect(s.get().items.map((l) => [l.key, l.saved])).toEqual([[s.get().items[0].key, true], [kConduit, true]]);
  });
});

describe("the page read the row again while the store was busy or dirty (S2)", () => {
  const fromServer = (title: string, price = 290) => ({ header: { title }, status: "draft", number: "E-001", items: [{ ...trench, id: "li-1", unit_price: price }] });
  it("held while a write is on the wire — the in-flight figure is not reverted — and applied once the write lands, once; the line that landed meanwhile keeps its figure", async () => {
    const g = gate<{ ok: boolean }>();
    const { s, a } = saved([{ ...trench, id: "li-1" }], { updateQuoteItem: vi.fn().mockReturnValueOnce(g.promise).mockResolvedValue({ ok: true }) });
    const key = s.get().items[0].key;
    s.typeLine(key, { unit_price: 310 });
    const write = s.commitLine(key);
    expect(s.get().pending).toBe(`line:${key}`);
    expect(s.isDirty()).toBe(false); // the record was taken at send
    // Stale props (the server's row from before this write) arrive mid-flight: held.
    s.reseed(fromServer("From the server", 290));
    expect(s.get().header.title).toBe("");
    expect(s.get().items[0].unit_price).toBe(310);
    g.release({ ok: true });
    expect(await write).toBe(true);
    // Applied at the landing: the title the server has; the figure this write landed stands (the
    // seed predates it — the write's own refresh follows and agrees).
    expect(s.get().header.title).toBe("From the server");
    expect(s.get().items[0].unit_price).toBe(310);
    // Once: a later landing does not bring the seed back over what he types next.
    s.typeHeader({ title: "Mine" });
    expect(await s.commitHeader("title")).toBe(true);
    expect(s.get().header.title).toBe("Mine");
    expect(a.updateQuoteMeta).toHaveBeenCalledTimes(1);
    // The next seed, taken when quiet: the write's own refresh.
    s.reseed({ ...fromServer("Mine", 310) });
    expect(s.get().header.title).toBe("Mine");
    expect(s.get().items[0].unit_price).toBe(310);
  });
  it("held while something typed is not yet committed (isDirty), and applied once the commit lands; the newest seed is the one applied", async () => {
    const { s } = saved([{ ...trench, id: "li-1" }, { ...task, id: "li-2" }]);
    const [k1] = s.get().items.map((l) => l.key);
    expect(s.isDirty()).toBe(false);
    s.typeLine(k1, { unit_price: 999 });
    expect(s.isDirty()).toBe(true);
    s.reseed(fromServer("First", 290));
    s.reseed(fromServer("Second", 290));
    expect(s.get().header.title).toBe(""); // held: what he is typing is not replaced
    expect(s.get().items[0].unit_price).toBe(999);
    expect(await s.commitLine(k1)).toBe(true);
    expect(s.isDirty()).toBe(false);
    // The latest seed, once: the title; the line he just wrote keeps 999; li-2 (not in the seed) is
    // the server's to drop.
    expect(s.get().header.title).toBe("Second");
    expect(s.get().items.map((l) => [l.id, l.unit_price])).toEqual([["li-1", 999]]);
    // Header text typed and not committed is dirty too; a named line not yet on the server as well.
    s.typeHeader({ notes: "Net 30" });
    expect(s.isDirty()).toBe(true);
    await s.commitHeader("notes");
    expect(s.isDirty()).toBe(false);
    const added = s.addLine(blank);
    expect(s.isDirty()).toBe(false); // a blank starter row is scratch
    s.typeLine(added, { description: "Backfill" });
    expect(s.isDirty()).toBe(true);
  });
  it("a seed that predates an append or a delete neither drops the new line nor brings the removed one back", async () => {
    const { s } = saved([{ ...trench, id: "li-1" }, { ...task, id: "li-2" }]);
    const [, k2] = s.get().items.map((l) => l.key);
    await s.addLines([{ ...trench, description: "Conduit" }]);
    await s.removeLine(k2);
    const own = s.get().items[1].id as string;
    // The row as it was before both: li-1 and li-2, no Conduit.
    s.reseed({ header: {}, status: "draft", number: "E-001", items: [{ ...trench, id: "li-1" }, { ...task, id: "li-2" }] });
    expect(s.get().items.map((l) => l.id)).toEqual(["li-1", own]);
    // The next seed (the server caught up) is taken whole.
    s.reseed({ header: {}, status: "sent", number: "E-001", items: [{ ...trench, id: "li-1", unit_price: 300 }, { ...trench, id: own, description: "Conduit" }] });
    expect(s.get().items.map((l) => [l.id, l.unit_price])).toEqual([["li-1", 300], [own, 290]]);
    expect(s.get().mode).toMatchObject({ status: "sent" });
  });
});

describe("the rule pass on a saved draft whose ids are not back yet (S3)", () => {
  const now = { levelRate: null, orgDefault: 135, people: [] };
  it("queues the id-less lines with their words instead of skipping them; the read-back's Retry drains them", async () => {
    const { s, a } = unsaved([task, trench], { readQuoteLineIds: vi.fn().mockResolvedValueOnce({ ok: false, error: "no" }).mockResolvedValue({ ok: true, items: [{ id: "li-1", sort_order: 0, description: task.description }, { id: "li-2", sort_order: 1, description: "Trench" }] }) });
    await s.mount();
    expect(s.get().refusals["read-back"]).toBe(READ_BACK_FAILED);
    const [kTask] = s.get().items.map((l) => l.key);
    expect(await s.reprice(now, 145)).toBe(false);
    expect(s.get().items[0].unit_price).toBe(270); // the mirror moved
    expect(a.updateQuoteItem).not.toHaveBeenCalled();
    expect(s.get().waiting[`line:${kTask}`]).toBe(WAITING_READ_BACK);
    expect(s.get().refusals.reprice).toBeUndefined();
    expect(isQuiet(s.get())).toBe(false);
    expect(await s.retry("read-back")).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(1);
    expect(a.updateQuoteItem).toHaveBeenCalledWith("li-1", CLIENT, expect.objectContaining({ unit_price: 270, detail: expect.objectContaining({ labor: [expect.objectContaining({ rate: 135 })] }) }));
    expect(s.get().waiting).toEqual({});
    expect(isQuiet(s.get())).toBe(true);
  });
});

describe("what the job's list did with an append (said / note)", () => {
  it("a kit added to an accepted, job-linked estimate: the said sits under the list, the note rides each line it was about", async () => {
    const { s } = saved([{ ...trench, id: "li-1" }], {
      appendQuoteLines: vi
        .fn()
        .mockImplementationOnce(async (_q: string, lines: { id: string }[]) => ({ ok: true, ids: lines.map((l) => l.id), said: "The job's list has them too.", note: "One part was already on the job's list." }))
        .mockImplementation(async (_q: string, lines: { id: string }[]) => ({ ok: true, ids: lines.map((l) => l.id) })),
    });
    expect(await s.addLines([task, { ...trench, description: "Conduit" }])).toBe(true);
    const [, k2, k3] = s.get().items.map((l) => l.key);
    expect(s.get().said).toBe("The job's list has them too.");
    expect(s.get().follow[k2]).toEqual({ note: "One part was already on the job's list." });
    expect(s.get().follow[k3]).toEqual({ note: "One part was already on the job's list." });
    // An append that followed nothing says nothing, and clears the last deed's words under the list.
    expect(await s.addLines([{ ...trench, description: "Backfill" }])).toBe(true);
    expect(s.get().said).toBeNull();
    expect(s.get().follow[s.get().items[3].key]).toBeUndefined();
  });
});

describe("only what he did HERE is substance", () => {
  const preset: EstimateHeader = { ...header, customerId: "c1", leadId: "l1" };
  it("a toggle of the document kind on a cold estimate opened with a preselected customer and lead births nothing; a customer picked here does", async () => {
    const { s, a } = unsaved([blank], {}, CLIENT, preset);
    s.typeHeader({ docType: "quote" });
    expect(await s.commitHeader("docType")).toBe(true);
    s.typeHeader({ estimateFormat: "detailed" });
    expect(await s.commitHeader("estimateFormat")).toBe(true);
    expect(a.saveQuote).not.toHaveBeenCalled();
    expect(s.get().mode.kind).toBe("unsaved");
    // He picks somebody: that is his, and the seed's lead and the held toggles ride the save.
    s.typeHeader({ customerId: "c2" });
    expect(await s.commitHeader("customerId")).toBe(true);
    expect(a.saveQuote).toHaveBeenCalledTimes(1);
    expect(calls(a.saveQuote)[0][0]).toMatchObject({ customer_id: "c2", inquiry_id: "l1", doc_type: "quote", estimate_format: "detailed", items: [] });
  });
  it("the seed with real lines still births at mount, preselected or not; the pure rule compares to the seed", async () => {
    const { s, a } = unsaved([task], {}, CLIENT, preset);
    await s.mount();
    expect(a.saveQuote).toHaveBeenCalledTimes(1);
    expect(calls(a.saveQuote)[0][0]).toMatchObject({ customer_id: "c1", inquiry_id: "l1" });
    expect(s.get().mode.kind).toBe("saved");
    expect(substantive(preset, [blank], preset)).toBe(false);
    expect(substantive({ ...preset, docType: "quote", taxRate: 0.1, validUntil: "2027-01-01" }, [blank], preset)).toBe(false);
    expect(substantive({ ...preset, customerId: "c2" }, [blank], preset)).toBe(true);
    expect(substantive({ ...preset, customerId: "" }, [blank], preset)).toBe(false); // un-picking is not a pick
    expect(substantive({ ...preset, title: "Larkspur panel" }, [blank], preset)).toBe(true);
    expect(substantive({ ...preset, title: "Larkspur panel" }, [blank], { ...preset, title: "Larkspur panel" })).toBe(false);
    expect(substantive(preset, [task], preset)).toBe(true);
    // Without a seed, anything on the header is his (the pure rule as the older tests use it).
    expect(substantive(preset, [blank])).toBe(true);
  });
});

describe("what was committed while the first save was on the wire (B1)", () => {
  it("a kit picked mid-flight is not marked saved by the landing; it is appended ONCE under its own id after the ids come back", async () => {
    const g = gate<{ ok: true; id: string; quote_number: string }>();
    const { s, a } = unsaved([trench], { saveQuote: vi.fn().mockReturnValueOnce(g.promise) });
    const first = s.mount();
    expect(s.get().pending).toBe("first-save");
    expect(await s.addLines([task])).toBe(false);
    const addedKey = s.get().items[1].key;
    expect(s.get().items[1]).toMatchObject({ saved: false, id: null });
    expect(s.get().waiting[`line:${addedKey}`]).toBe(STILL_SAVING);
    expect(s.get().refusals).toEqual({});
    expect(a.appendQuoteLines).not.toHaveBeenCalled();
    g.release({ ok: true, id: CLIENT, quote_number: "E-012" });
    expect(await first).toBe(true);
    // The landing marked only the line that went; the read-back gave it its id; then ONE append under
    // an id chosen at the append (the read-back never touches the added line).
    expect(calls(a.saveQuote)[0][0].items).toEqual([trench]);
    const added = s.get().items[1];
    expect(added.id).toMatch(/^id-/);
    expect(a.appendQuoteLines).toHaveBeenCalledTimes(1);
    expect(a.appendQuoteLines).toHaveBeenCalledWith(CLIENT, [{ ...task, id: added.id }]);
    expect(s.get().items.map((l) => [l.id, l.saved])).toEqual([["li-1", true], [added.id, true]]);
    expect(s.get().waiting).toEqual({});
    expect(s.get().refusals).toEqual({});
    expect(isQuiet(s.get())).toBe(true);
  });

  it("a header field committed mid-flight is not in the payload that went; it is ONE updateQuoteMeta after the landing", async () => {
    const g = gate<{ ok: true; id: string }>();
    const { s, a } = unsaved([trench], { saveQuote: vi.fn().mockReturnValueOnce(g.promise) });
    const first = s.mount();
    s.typeHeader({ title: "Larkspur panel" });
    expect(await s.commitHeader("title")).toBe(false);
    expect(s.get().waiting["header:title"]).toBe(STILL_SAVING);
    g.release({ ok: true, id: CLIENT });
    expect(await first).toBe(true);
    expect(calls(a.saveQuote)[0][0].title).toBe("");
    expect(a.updateQuoteMeta).toHaveBeenCalledTimes(1);
    expect(a.updateQuoteMeta).toHaveBeenCalledWith(CLIENT, { title: "Larkspur panel" });
    expect(s.get().waiting).toEqual({});
    // Committed again with nothing new: nothing more goes.
    expect(await s.commitHeader("title")).toBe(true);
    expect(a.updateQuoteMeta).toHaveBeenCalledTimes(1);
  });

  it("a line edited mid-flight keeps its typed figure, is marked sent only as it went, and is written once its id is back", async () => {
    const g = gate<{ ok: true; id: string }>();
    const { s, a } = unsaved([trench, task], { saveQuote: vi.fn().mockReturnValueOnce(g.promise) });
    const first = s.mount();
    const [k1] = s.get().items.map((l) => l.key);
    s.typeLine(k1, { unit_price: 310 });
    expect(await s.commitLine(k1)).toBe(false);
    expect(s.get().waiting[`line:${k1}`]).toBe(STILL_SAVING);
    g.release({ ok: true, id: CLIENT });
    expect(await first).toBe(true);
    expect(calls(a.saveQuote)[0][0].items[0]).toMatchObject({ unit_price: 290 }); // what went
    expect(s.get().items[0]).toMatchObject({ id: "li-1", saved: true, unit_price: 310 }); // what he typed
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(1);
    expect(a.updateQuoteItem).toHaveBeenCalledWith("li-1", CLIENT, expect.objectContaining({ unit_price: 310 }));
    expect(a.appendQuoteLines).not.toHaveBeenCalled();
    expect(s.get().waiting).toEqual({});
  });

  it("a line the first save carried, removed mid-flight, stays until the ids are back and is then deleted on the server — never dropped from the order the read-back matches on", async () => {
    const g = gate<{ ok: true; id: string }>();
    const { s, a } = unsaved([trench, task], { saveQuote: vi.fn().mockReturnValueOnce(g.promise) });
    const first = s.mount();
    const [, k2] = s.get().items.map((l) => l.key);
    expect(await s.removeLine(k2)).toBe(false);
    expect(s.get().items.length).toBe(2);
    expect(s.get().waiting[`line:${k2}`]).toBe(STILL_SAVING);
    g.release({ ok: true, id: CLIENT });
    expect(await first).toBe(true);
    expect(a.deleteQuoteItem).toHaveBeenCalledTimes(1);
    expect(a.deleteQuoteItem).toHaveBeenCalledWith("li-2", CLIENT);
    expect(s.get().items.map((l) => l.id)).toEqual(["li-1"]);
    expect(s.get().waiting).toEqual({});
  });

  it("a blank line added mid-flight and left blank is never sent; a never-saved line removed mid-flight just goes", async () => {
    const g = gate<{ ok: true; id: string }>();
    const { s, a } = unsaved([trench], { saveQuote: vi.fn().mockReturnValueOnce(g.promise) });
    const first = s.mount();
    const key = s.addLine(blank);
    expect(await s.commitLine(key)).toBe(false);
    const gone = s.addLine({ ...trench, description: "Backfill" });
    expect(await s.removeLine(gone)).toBe(true);
    g.release({ ok: true, id: CLIENT });
    expect(await first).toBe(true);
    expect(a.appendQuoteLines).not.toHaveBeenCalled();
    expect(s.get().items.map((l) => [l.key, l.saved])).toEqual([[s.get().items[0].key, true], [key, false]]);
    expect(s.get().waiting).toEqual({});
  });

  it("the refused first save: what was committed during the flight rides ONE fresh save of the estimate as it stands", async () => {
    const g = gate<{ ok: false; error: string }>();
    const { s, a } = unsaved([trench], { saveQuote: vi.fn().mockReturnValueOnce(g.promise).mockResolvedValue({ ok: true, id: CLIENT }) });
    const first = s.mount();
    s.typeHeader({ title: "Larkspur panel" });
    await s.commitHeader("title");
    await s.addLines([task]);
    g.release({ ok: false, error: "Couldn't save." });
    expect(await first).toBe(false);
    // The refusal freed the wire; the queue rode one more save with everything as it stands.
    expect(a.saveQuote).toHaveBeenCalledTimes(2);
    expect(calls(a.saveQuote)[1][0]).toMatchObject({ id: CLIENT, title: "Larkspur panel", items: [trench, task] });
    expect(s.get().mode.kind).toBe("saved");
    expect(a.appendQuoteLines).not.toHaveBeenCalled();
    expect(s.get().refusals).toEqual({});
    expect(s.get().waiting).toEqual({});
  });
});

describe("a first save needs substance (S2)", () => {
  it("a blur on a blank line births nothing; a figure with no words asks for them and births nothing", async () => {
    const { s, a } = unsaved([blank]);
    const key = s.get().items[0].key;
    expect(await s.commitLine(key)).toBe(false);
    expect(a.saveQuote).not.toHaveBeenCalled();
    s.typeLine(key, { unit_price: 40 });
    expect(await s.commitLine(key)).toBe(false);
    expect(s.get().waiting[`line:${key}`]).toBe(NAME_THE_LINE);
    expect(a.saveQuote).not.toHaveBeenCalled();
  });
  it("the document kind or the paper format toggled on a cold estimate is held, and rides the first save once a line is named", async () => {
    const { s, a } = unsaved([blank]);
    s.typeHeader({ docType: "quote" });
    expect(await s.commitHeader("docType")).toBe(true);
    s.typeHeader({ estimateFormat: "detailed" });
    expect(await s.commitHeader("estimateFormat")).toBe(true);
    s.typeHeader({ taxRate: 0.0825 });
    expect(await s.commitHeader("taxRate")).toBe(true);
    expect(a.saveQuote).not.toHaveBeenCalled();
    expect(s.get().mode.kind).toBe("unsaved");
    const key = s.get().items[0].key;
    s.typeLine(key, { description: "Trench", unit_price: 290 });
    expect(await s.commitLine(key)).toBe(true);
    expect(a.saveQuote).toHaveBeenCalledTimes(1);
    expect(calls(a.saveQuote)[0][0]).toMatchObject({ doc_type: "quote", estimate_format: "detailed", tax_rate: 0.0825, items: [{ description: "Trench" }] });
    expect(a.updateQuoteMeta).not.toHaveBeenCalled();
    expect(a.setQuoteType).not.toHaveBeenCalled();
  });
  it("header text he typed, or somebody picked, IS substance", async () => {
    const titled = unsaved([blank]);
    titled.s.typeHeader({ title: "Larkspur panel" });
    expect(await titled.s.commitHeader("title")).toBe(true);
    expect(titled.a.saveQuote).toHaveBeenCalledTimes(1);
    expect(calls(titled.a.saveQuote)[0][0]).toMatchObject({ title: "Larkspur panel", items: [] });
    const picked = unsaved([blank]);
    picked.s.typeHeader({ customerId: "c1" });
    expect(await picked.s.commitHeader("customerId")).toBe(true);
    expect(calls(picked.a.saveQuote)[0][0]).toMatchObject({ customer_id: "c1" });
    expect(substantive(header, [blank])).toBe(false);
    expect(substantive({ ...header, leadId: "l1" }, [])).toBe(true);
    expect(substantive({ ...header, docType: "quote", estimateFormat: "detailed", taxRate: 0.1 }, [blank])).toBe(false);
  });
});

describe("nothing moves silently on a sent estimate", () => {
  const now = { levelRate: null, orgDefault: 135, people: [] };
  it("the rule pass re-prices a rule row on a draft, and leaves a sent, accepted or superseded estimate exactly as it is", () => {
    const priced = repricedLines([task], "draft", now, 145);
    expect(priced[0].detail?.labor[0].rate).toBe(135);
    expect(priced[0].unit_price).toBe(270);
    for (const status of ["sent", "accepted", "superseded", "declined"]) {
      const same = repricedLines([task], status, now, 145);
      expect(same[0]).toBe(task);
    }
  });
  it("on a saved draft the pass writes each changed line as ONE deed; on a sent estimate it writes nothing", async () => {
    const draft = saved([{ ...task, id: "li-2" }, { ...trench, id: "li-1" }]);
    expect(await draft.s.reprice(now, 145)).toBe(true);
    expect(draft.a.updateQuoteItem).toHaveBeenCalledTimes(1);
    expect(draft.a.updateQuoteItem).toHaveBeenCalledWith("li-2", "q1", expect.objectContaining({ unit_price: 270, detail: expect.objectContaining({ labor: [expect.objectContaining({ rate: 135 })] }) }));
    const sent = saved([{ ...task, id: "li-2" }], {}, "sent");
    expect(await sent.s.reprice(now, 145)).toBe(true);
    expect(sent.a.updateQuoteItem).not.toHaveBeenCalled();
    expect(sent.s.get().items[0].detail?.labor[0].rate).toBe(145);
  });
  it("a refused pass names the line and Retry carries on from the lines still unwritten", async () => {
    const two = [{ ...task, id: "li-2" }, { ...task, id: "li-3", description: "Second task", detail: detail({ task_id: "t2" }) }];
    const { s, a } = saved(two, { updateQuoteItem: vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: "locked" }).mockResolvedValue({ ok: true }) });
    expect(await s.reprice(now, 145)).toBe(false);
    expect(s.get().refusals.reprice).toBe("Second task: locked");
    expect(await s.retry("reprice")).toBe(true);
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(3);
    expect(calls(a.updateQuoteItem)[2][0]).toBe("li-3");
  });
  it("a pass asked for while a write is on the wire queues its lines and writes them after", async () => {
    const g = gate<{ ok: boolean }>();
    const { s, a } = saved([{ ...task, id: "li-2" }, { ...trench, id: "li-1" }], { updateQuoteItem: vi.fn().mockReturnValueOnce(g.promise).mockResolvedValue({ ok: true }) });
    const [, k1] = s.get().items.map((l) => l.key);
    s.typeLine(k1, { unit_price: 300 });
    const first = s.commitLine(k1);
    expect(await s.reprice(now, 145)).toBe(false);
    expect(s.get().items[0].unit_price).toBe(270); // the mirror moved at once
    g.release({ ok: true });
    await first;
    expect(a.updateQuoteItem).toHaveBeenCalledTimes(2);
    expect(calls(a.updateQuoteItem)[1]).toEqual(["li-2", "q1", expect.objectContaining({ unit_price: 270 })]);
  });
});

describe("the page read the row again", () => {
  it("what landed replaces the mirror; a refused row keeps its typed figure; a line unsaved here stays", async () => {
    const { s } = saved([{ ...trench, id: "li-1" }, { ...task, id: "li-2" }], { updateQuoteItem: vi.fn(async () => ({ ok: false, error: "no" })) });
    const [k1] = s.get().items.map((l) => l.key);
    s.typeLine(k1, { unit_price: 999 });
    await s.commitLine(k1);
    const blankKey = s.addLine(blank);
    s.reseed({ header: { title: "From the server" }, status: "sent", number: "E-001", items: [{ ...trench, id: "li-1", unit_price: 290 }, { ...task, id: "li-2", quantity: 2 }, { ...trench, id: "li-9", description: "Added elsewhere" }] });
    const items = s.get().items;
    expect(items[0]).toMatchObject({ key: k1, unit_price: 999 }); // refused: his figure stands
    expect(items[1]).toMatchObject({ id: "li-2", quantity: 2 }); // landed: the server's
    expect(items[2]).toMatchObject({ id: "li-9", saved: true });
    expect(items[3]).toMatchObject({ key: blankKey, saved: false });
    expect(s.get().header.title).toBe("From the server");
    expect(s.get().mode).toMatchObject({ status: "sent" });
  });
});

describe("the read-back matches by the words that WENT (skeptic #39, B3)", () => {
  it("a line renamed and committed while the first save was out: the row that says the sent words is its, the rename goes as its own update, and the store is quiet", async () => {
    const g = gate<{ ok: true; id: string; quote_number: string }>();
    const { s, a } = unsaved([{ ...trench, description: "Outlet", unit_price: 5 }]);
    (a.saveQuote as ReturnType<typeof vi.fn>).mockImplementation(async () => g.promise);
    const [key] = s.get().items.map((l) => l.key);
    const first = s.commitLine(key); // the first save, carrying "Outlet", on the wire
    s.typeLine(key, { description: "Outlets" }); // a typo fixed in flight
    const second = s.commitLine(key); // queued behind the wire
    expect(s.get().waiting[`line:${key}`]).toBe(STILL_SAVING);
    g.release({ ok: true, id: CLIENT, quote_number: "E-012" });
    await first;
    await second;
    // The read-back answered "Outlet" (what went) — matched onto the line now saying "Outlets".
    expect(calls(a.readQuoteLineIds)).toHaveLength(1);
    expect(s.get().items[0]).toMatchObject({ id: "li-1", saved: true, description: "Outlets" });
    expect(s.get().refusals).toEqual({});
    expect(s.get().waiting).toEqual({});
    // Then the queued rename went as a normal update under the id, once.
    expect(calls(a.updateQuoteItem)).toEqual([["li-1", CLIENT, expect.objectContaining({ description: "Outlets" })]]);
    expect(isQuiet(s.get())).toBe(true);
    expect(s.isDirty()).toBe(false);
  });

  it("the pure rule: `sent` wins over the current words; a line with no record is matched by its current words", () => {
    const items = [
      { key: "a", id: null, saved: true, description: "Outlets", quantity: 1, unit: "ea", unit_price: 5 },
      { key: "b", id: null, saved: true, description: "Trench", quantity: 1, unit: "ea", unit_price: 290 },
    ];
    const read = [{ id: "r1", sort_order: 0, description: "Outlet" }, { id: "r2", sort_order: 1, description: "Trench" }];
    expect(idsBySortOrder(items, read).map((l) => l.id)).toEqual([null, "r2"]);
    expect(idsBySortOrder(items, read, (key) => (key === "a" ? "Outlet" : undefined)).map((l) => l.id)).toEqual(["r1", "r2"]);
  });
});

describe("a line of a refused append goes with its set (skeptic #39, B4)", () => {
  it("a refused append of [A, B]; A is edited and committed alone: the same slot re-sends BOTH (under the same ids), both land, no refusal or waiting is left, and the store is clean", async () => {
    let fail = true;
    const sent: [string, string, number][][] = [];
    const { s } = saved([{ ...trench, id: "e1", description: "Existing" }], {
      appendQuoteLines: vi.fn(async (_q: string, lines: (DraftLineItem & { id: string })[]) => {
        sent.push(lines.map((l) => [l.description, l.id, l.unit_price]));
        if (fail) throw new Error("lost");
        return { ok: true as const, ids: lines.map((l) => l.id) };
      }),
    });
    await s.addLines([{ ...trench, description: "A", unit_price: 10 }, { ...trench, description: "B", unit_price: 10 }]);
    const slot = Object.keys(s.get().refusals).find((k) => k.startsWith("append:"))!;
    expect(s.get().refusals[slot]).toBe(COULD_NOT_REACH);
    const [, kA] = s.get().items.map((l) => l.key);
    const [idA, idB] = s.get().items.slice(1).map((l) => l.id);
    s.typeLine(kA, { unit_price: 99 });
    fail = false;
    expect(await s.commitLine(kA)).toBe(true);
    expect(s.get().items.map((l) => [l.description, l.saved, l.id, l.unit_price])).toEqual([["Existing", true, "e1", 290], ["A", true, idA, 99], ["B", true, idB, 10]]);
    expect(s.get().refusals).toEqual({});
    expect(s.get().waiting).toEqual({});
    expect(sent).toEqual([[["A", idA, 10], ["B", idB, 10]], [["A", idA, 99], ["B", idB, 10]]]);
    expect(s.isDirty()).toBe(false);
    expect(isQuiet(s.get())).toBe(true);
    // Nothing left to retry on the slot.
    expect(await s.retry(slot)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("B committed alone while another write is on the wire (the catch-up path) widens to the set the same way", async () => {
    let fail = true;
    const sent: string[][] = [];
    const g = gate<{ ok: boolean }>();
    const { s, a } = saved([{ ...trench, id: "e1", description: "Existing" }], {
      appendQuoteLines: vi.fn(async (_q: string, lines: (DraftLineItem & { id: string })[]) => {
        sent.push(lines.map((l) => l.description));
        if (fail) return { ok: false as const, error: "no room" };
        return { ok: true as const, ids: lines.map((l) => l.id) };
      }),
      updateQuoteItem: vi.fn().mockReturnValueOnce(g.promise).mockResolvedValue({ ok: true }),
    });
    await s.addLines([{ ...trench, description: "A" }, { ...trench, description: "B" }]);
    const [kE, , kB] = s.get().items.map((l) => l.key);
    s.typeLine(kE, { unit_price: 300 });
    const busyWrite = s.commitLine(kE); // the wire is busy with Existing
    s.typeLine(kB, { unit_price: 77 });
    expect(await s.commitLine(kB)).toBe(false); // queued
    fail = false;
    g.release({ ok: true });
    await busyWrite;
    expect(sent).toEqual([["A", "B"], ["A", "B"]]); // the catch-up sent the whole set, not B alone
    expect(s.get().items.slice(1).map((l) => [l.description, l.saved, l.unit_price])).toEqual([["A", true, 290], ["B", true, 77]]);
    expect(s.get().refusals).toEqual({});
    expect(calls(a.appendQuoteLines)).toHaveLength(2);
  });
});
