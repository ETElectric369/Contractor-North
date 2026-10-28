import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ONE DOWNLOAD BUTTON (cn-v1138): the fetch-and-verdict says a refusal in the route's own words and
 * hands back the file under the route's name; a 200 blob goes through an <a download> click; in the
 * shell a shareable file goes to the share sheet. The pieces are pure (fetchTheFile, routeFor,
 * saveThroughAnchor) and driven with fakes; the button and the accountant card render with their
 * words. No DOM here (the unit project runs in node), so the anchor is a recording fake.
 */
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => false }));
vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn(async () => {}) }));
vi.mock("@/app/(app)/analytics/accountant/period-picker", () => ({ useOpeningPeriod: () => null }));

import { DownloadButton, fetchTheFile, routeFor, saveThroughAnchor, MAKING_IT, SAVE_THE_FILE } from "./download-button";
import { AccountantDownload } from "@/app/(app)/analytics/accountant/accountant-download";
import { SIGNED_OUT_WORDS, NOT_THE_FILE_WORDS, ZIP_TYPE } from "@/lib/download-response";

type Fake = { ok: boolean; status: number; type?: string; redirected?: boolean; headers?: Record<string, string>; text?: string; bytes?: number[] };
const response = (f: Fake) =>
  ({
    ok: f.ok,
    status: f.status,
    type: f.type ?? "basic",
    redirected: f.redirected ?? false,
    headers: { get: (k: string) => f.headers?.[k.toLowerCase()] ?? null },
    text: async () => f.text ?? "",
    blob: async () => new Blob([new Uint8Array(f.bytes ?? [])], { type: f.headers?.["content-type"] }),
  }) as unknown as Response;
const fetching = (f: Fake, seen: unknown[][] = []) =>
  (async (...a: unknown[]) => {
    seen.push(a);
    return response(f);
  }) as unknown as typeof fetch;

describe("fetchTheFile", () => {
  it("a refusal's plain-text body is the words shown on the card; nothing is read as a file", async () => {
    const seen: unknown[][] = [];
    const got = await fetchTheFile("/export", "zip", "Fallback.zip", fetching({ ok: false, status: 403, headers: { "content-type": "text/plain; charset=utf-8" }, text: "Ask Larkspur to download the company's data." }, seen));
    expect(got).toEqual({ ok: false, words: "Ask Larkspur to download the company's data." });
    // Never follows the middleware's redirect to the login page, never a cached copy.
    expect(seen).toEqual([["/export", { cache: "no-store", redirect: "manual" }]]);
  });

  it("signed out (an opaque redirect) and a page instead of the file are said, never saved", async () => {
    expect(await fetchTheFile("/export", "zip", "F.zip", fetching({ ok: false, status: 0, type: "opaqueredirect" }))).toEqual({ ok: false, words: SIGNED_OUT_WORDS });
    expect(await fetchTheFile("/export", "zip", "F.zip", fetching({ ok: true, status: 200, headers: { "content-type": "text/html" } }))).toEqual({ ok: false, words: NOT_THE_FILE_WORDS });
  });

  it("a 200 zip comes back as the blob under the route's own name (the fallback when it gave none)", async () => {
    const named = await fetchTheFile("/export", "zip", "Fallback.zip", fetching({ ok: true, status: 200, headers: { "content-type": ZIP_TYPE, "content-disposition": `attachment; filename="Harbor 2026.zip"; filename*=UTF-8''Harbor%202026.zip` }, bytes: [80, 75, 3, 4] }));
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(named.name).toBe("Harbor 2026.zip");
    expect(named.type).toBe(ZIP_TYPE);
    expect(new Uint8Array(await named.blob.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]));
    const unnamed = await fetchTheFile("/export", "zip", "Fallback.zip", fetching({ ok: true, status: 200, headers: { "content-type": ZIP_TYPE, "content-disposition": "attachment" } }));
    expect(unnamed.ok && unnamed.name).toBe("Fallback.zip");
  });
});

describe("where the file goes", () => {
  it("a 200 blob triggers the anchor: href from the blob, download = the name, clicked once, removed, the URL let go", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const a = { href: "", download: "", click: () => events.push("click"), remove: () => events.push("remove") };
    const doc = { createElement: () => a, body: { appendChild: () => events.push("append") } } as unknown as Document;
    const urls = { createObjectURL: () => "blob:x", revokeObjectURL: () => events.push("revoke") };
    saveThroughAnchor(new Blob([new Uint8Array([1])]), "Harbor 2026.zip", doc, urls);
    expect(a).toMatchObject({ href: "blob:x", download: "Harbor 2026.zip" });
    expect(events).toEqual(["append", "click", "remove"]);
    vi.runAllTimers();
    expect(events).toEqual(["append", "click", "remove", "revoke"]);
    vi.useRealTimers();
  });

  it("in the shell a shareable file goes to the share sheet; a phone that can't share files is told; a browser downloads", () => {
    const file = new File([new Uint8Array([1])], "a.zip", { type: ZIP_TYPE });
    const canShare = { share: async () => {}, canShare: () => true } as unknown as Navigator;
    const cannot = { share: async () => {}, canShare: () => false } as unknown as Navigator;
    expect(routeFor(file, true, canShare)).toBe("share-sheet");
    expect(routeFor(file, true, cannot)).toBe("safari");
    expect(routeFor(file, true, undefined)).toBe("safari");
    expect(routeFor(file, false, undefined)).toBe("download");
  });
});

describe("the buttons", () => {
  it("DownloadButton renders its label at rest, with no Save The File until the shell keeps a file", () => {
    const html = renderToStaticMarkup(createElement(DownloadButton, { href: "/export", fileName: "Harbor 2026.zip", label: "Download Everything" }));
    expect(html).toContain("Download Everything");
    expect(html).not.toContain(MAKING_IT);
    expect(html).not.toContain(SAVE_THE_FILE);
    expect(html).not.toContain('role="alert"');
    expect(MAKING_IT).toBe("Making It…");
    expect(SAVE_THE_FILE).toBe("Save The File");
  });

  it("the accountant card keeps its words on the shared hook", () => {
    const html = renderToStaticMarkup(createElement(AccountantDownload, { xlsxHref: "/x", csvHref: "/c", xlsxName: "Harbor 2026 Q3.xlsx", csvName: "Harbor 2026 Q3 CSV.zip" }));
    expect(html).toContain("Download For Your Accountant");
    expect(html).toContain("Same Thing As CSV Files");
    expect(html).toContain("File: Harbor 2026 Q3.xlsx");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/analytics/accountant/accountant-download.tsx"), "utf8");
    expect(src).toContain("useFileDownload()");
    expect(src).not.toContain("navigator.share");
    expect(src).toContain('"Making It…"');
    expect(src).toContain("Save The File");
  });
});
