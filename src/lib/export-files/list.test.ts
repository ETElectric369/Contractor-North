import { describe, it, expect } from "vitest";
import { LIST_MAX_DEPTH, LIST_MAX_PAGES, LIST_PAGE, walkFolder, type ListEntry, type ListSvc } from "./list";

/**
 * A FOLDER, WALKED — OR A FAILURE (cn-v1138). Supabase lists one level at a time; the walk goes
 * LIST_MAX_DEPTH folders down and pages at 1,000. A folder deeper than the walk goes is a FAILURE,
 * never a folder quietly left out (the route then says the files could not be listed and hands
 * nothing partial over); so is a failed page and a run past the page cap.
 */
type Obj = { path: string; size?: number | null };

/** A storage fake over whole keys, answering one level per call the way Supabase does. */
function storage(objects: Obj[], opts: { fail?: string; pages?: Record<string, ListEntry[][]> } = {}): ListSvc & { lists: string[] } {
  const lists: string[] = [];
  return {
    lists,
    storage: {
      from: () => ({
        list: async (prefix: string, { limit, offset }: { limit: number; offset: number }) => {
          lists.push(prefix);
          if (opts.fail === prefix) return { data: null, error: { message: "boom" } };
          if (opts.pages?.[prefix]) return { data: opts.pages[prefix][offset / limit] ?? [], error: null };
          const head = prefix ? `${prefix}/` : "";
          const entries = new Map<string, ListEntry>();
          for (const o of objects) {
            if (!o.path.startsWith(head)) continue;
            const rest = o.path.slice(head.length);
            const slash = rest.indexOf("/");
            if (slash < 0) entries.set(rest, { name: rest, id: `id-${o.path}`, metadata: { size: o.size ?? null } });
            else if (!entries.has(rest.slice(0, slash))) entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null });
          }
          return { data: Array.from(entries.values()).slice(offset, offset + limit), error: null };
        },
      }),
    },
  };
}

describe("walkFolder", () => {
  it("every file under the prefix, folders walked down, each with its whole key and its size; the placeholder skipped", async () => {
    const svc = storage([
      { path: "org-1/employees/p1/1-a.pdf", size: 10 },
      { path: "org-1/employees/p2/2-b.pdf", size: 20 },
      { path: "org-1/employees/.emptyFolderPlaceholder", size: 0 },
      { path: "org-1/employees/loose.pdf", size: null },
      { path: "org-2/employees/p1/theirs.pdf", size: 1 },
    ]);
    expect(await walkFolder(svc, "documents", "org-1/employees")).toEqual({
      ok: true,
      files: [
        { path: "org-1/employees/p1/1-a.pdf", size: 10 },
        { path: "org-1/employees/p2/2-b.pdf", size: 20 },
        { path: "org-1/employees/loose.pdf", size: null },
      ],
    });
    expect(svc.lists).toEqual(["org-1/employees", "org-1/employees/p1", "org-1/employees/p2"]);
  });

  it("a folder deeper than the walk goes is a failure in words, never a folder left out", async () => {
    expect(LIST_MAX_DEPTH).toBe(3);
    const svc = storage([{ path: "org-1/a/b/c/d/deep.pdf", size: 1 }, { path: "org-1/a/shallow.pdf", size: 2 }]);
    const walk = await walkFolder(svc, "documents", "org-1");
    expect(walk.ok).toBe(false);
    expect(String((walk as { error: Error }).error.message)).toBe("deeper than 3 under documents/org-1/a/b/c/d");
    // Exactly three levels below the prefix is fine.
    const fine = await walkFolder(storage([{ path: "org-1/a/b/c/ok.pdf", size: 1 }]), "documents", "org-1");
    expect(fine).toEqual({ ok: true, files: [{ path: "org-1/a/b/c/ok.pdf", size: 1 }] });
    // A caller's own smaller depth is honored the same way.
    const one = await walkFolder(storage([{ path: "org-1/a/b/x.pdf", size: 1 }]), "documents", "org-1", 1);
    expect(one.ok).toBe(false);
    expect(String((one as { error: Error }).error.message)).toBe("deeper than 3 under documents/org-1/a/b");
  });

  it("a page that fails, anywhere in the walk, is a failure with the storage error; nothing shorter", async () => {
    const svc = storage([{ path: "org-1/a/1.pdf" }, { path: "org-1/b/2.pdf" }], { fail: "org-1/b" });
    expect(await walkFolder(svc, "documents", "org-1")).toEqual({ ok: false, error: { message: "boom" } });
    expect(await walkFolder(storage([], { fail: "org-1" }), "documents", "org-1")).toEqual({ ok: false, error: { message: "boom" } });
  });

  it("pages at 1,000 until a short page; a run past the page cap is a failure", async () => {
    expect(LIST_PAGE).toBe(1000);
    expect(LIST_MAX_PAGES).toBe(20);
    const full = Array.from({ length: LIST_PAGE }, (_, i) => ({ name: `${i}.jpg`, id: `id-${i}`, metadata: { size: 1 } }));
    const svc = storage([], { pages: { "org-1": [full, full.slice(0, 3)] } });
    const walk = await walkFolder(svc, "documents", "org-1");
    expect(walk.ok).toBe(true);
    expect((walk as { files: unknown[] }).files).toHaveLength(LIST_PAGE + 3);
    const endless = storage([], { pages: { "org-1": Array.from({ length: LIST_MAX_PAGES + 1 }, () => full) } });
    const capped = await walkFolder(endless, "documents", "org-1");
    expect(capped.ok).toBe(false);
    expect(String((capped as { error: Error }).error.message)).toBe("more than 20000 objects under documents/org-1");
  });
});
