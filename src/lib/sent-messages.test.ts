import { describe, it, expect, vi, beforeEach } from "vitest";
import { logSend, readSentMessages, senderEmail, type SentMessageRow } from "@/lib/sent-messages";
import { reportError } from "@/lib/observe";

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const ROW: SentMessageRow = {
  orgId: "org-1", docKind: "invoice", docId: "inv-1", customerId: "cus-1", channel: "email",
  to: "dana@larkspur.example", subject: "Your invoice", body: "Hi Dana", copyTo: "sam@larkspur.example", sentBy: "u-1", auto: false,
};

/** A chain that records calls and resolves to `result` wherever it is awaited. */
function fake(result: { data?: unknown; error?: unknown }, onThrow = false) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const chain: any = new Proxy({}, {
    get: (_t, fn: string) => {
      if (fn === "then") return (res: (v: unknown) => void) => res({ data: result.data ?? null, error: result.error ?? null });
      return (...args: unknown[]) => {
        calls.push({ fn, args });
        if (onThrow && fn === "insert") throw new Error("client exploded");
        return chain;
      };
    },
  });
  return { client: { from: (t: string) => (calls.push({ fn: "from", args: [t] }), chain) } as any, calls };
}

beforeEach(() => vi.mocked(reportError).mockClear());

describe("logSend", () => {
  it("inserts the row under its company and asks for the id back", async () => {
    const { client, calls } = fake({ data: [{ id: "x" }] });
    await logSend(client, ROW);
    expect(calls[0]).toEqual({ fn: "from", args: ["sent_messages"] });
    const ins = calls.find((c) => c.fn === "insert")!.args[0] as any;
    expect(ins).toMatchObject({ org_id: "org-1", doc_kind: "invoice", to_addr: "dana@larkspur.example", copy_to: "sam@larkspur.example", auto: false });
    expect(calls.some((c) => c.fn === "select" && c.args[0] === "id")).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("swallows a database error and files it", async () => {
    const { client } = fake({ error: { message: "nope" } });
    await expect(logSend(client, ROW)).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith("send:log", { message: "nope" }, { orgId: "org-1", docKind: "invoice" });
  });

  it("swallows a client that throws", async () => {
    const { client } = fake({}, true);
    await expect(logSend(client, ROW)).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("readSentMessages", () => {
  it("filters by company and document, newest first, and maps the rows", async () => {
    const { client, calls } = fake({
      data: [
        { id: "b", channel: "sms", to_addr: "+15305550133", subject: null, body: "Hi", copy_to: null, sent_by: null, sent_at: "2026-11-08T10:00:00Z", auto: true, profiles: null },
        { id: "a", channel: "email", to_addr: "dana@larkspur.example", subject: "S", body: "B", copy_to: "c@x.example", sent_by: "u-1", sent_at: "2026-11-07T10:00:00Z", auto: false, profiles: { full_name: "Sam Tillery" } },
      ],
    });
    const out = await readSentMessages(client, "org-1", "invoice", "inv-1");
    expect(calls.filter((c) => c.fn === "eq").map((c) => c.args)).toEqual([["org_id", "org-1"], ["doc_kind", "invoice"], ["doc_id", "inv-1"]]);
    expect(calls.find((c) => c.fn === "order")!.args).toEqual(["sent_at", { ascending: false }]);
    expect(calls.find((c) => c.fn === "limit")!.args).toEqual([20]);
    expect(out.map((m) => m.id)).toEqual(["b", "a"]);
    expect(out[0]).toMatchObject({ channel: "sms", to: "+15305550133", sentByName: null, auto: true });
    expect(out[1]).toMatchObject({ sentByName: "Sam Tillery", copyTo: "c@x.example", subject: "S" });
  });
});

describe("senderEmail", () => {
  it("is the profile's email, trimmed, or null", async () => {
    expect(await senderEmail(fake({ data: { email: " sam@larkspur.example " } }).client, "u-1")).toBe("sam@larkspur.example");
    expect(await senderEmail(fake({ data: { email: "" } }).client, "u-1")).toBeNull();
    expect(await senderEmail(fake({ data: null }).client, "u-1")).toBeNull();
  });
});
