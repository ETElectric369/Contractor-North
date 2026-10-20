import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Inspector's carried findings, group B (audit v1120, 2026-10-17): the 3D Scan model's trip.
 *
 *   7, 16, 40  a model whose trip did not finish was kept for a camera-less resend that (a) could not
 *              tell "the file did not upload" from "the row did not save" (so a model that was up
 *              went up a second time, and the page grew a second tile), (b) was bound to no task
 *              (so the old room's model landed on whichever task was tapped next), and (c) had no
 *              way out (a refusal that never changes looped for good);
 *   34         the job copy's failure put storage's own sentence in front of the contractor;
 *   8          a model that failed to come over the bridge was left in the phone's temp folder under
 *              a sentence that promised a retry which is a whole new walk.
 *
 * The page cases drive the REAL Inspector: its hooks are swapped for a few lines of state so one
 * component function can be called again and again, and its buttons are tapped the way a thumb
 * would. Storage, the actions and the camera are the mocks.
 */

const h = vi.hoisted(() => ({
  hooks: [] as Array<{ v?: unknown; current?: unknown }>,
  i: 0,
  shell: false,
  scan3dNative: vi.fn(),
  discardScan: vi.fn(async (_path: string) => undefined),
  uploads: [] as string[],
  uploadError: null as null | { message: string; statusCode?: string },
  removes: [] as string[][],
  /** removeInspectionPhoto(appointmentId, path): the one door a photo comes off a visit through. */
  doorRemoves: [] as string[][],
  copyError: null as null | { message: string },
  copies: [] as string[][],
  saveCapture: vi.fn(),
  addInspectionPhotos: vi.fn(),
  addDocument: vi.fn(),
}));

// One component function called again and again: state and refs live in slots, in call order.
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  const slot = <T>(make: () => T): T => {
    const at = h.i++;
    if (!(at in h.hooks)) h.hooks[at] = make() as never;
    return h.hooks[at] as T;
  };
  return {
    ...real,
    useState: (init: unknown) => {
      const cell = slot(() => ({ v: typeof init === "function" ? (init as () => unknown)() : init }));
      return [cell.v, (n: unknown) => void (cell.v = typeof n === "function" ? (n as (x: unknown) => unknown)(cell.v) : n)];
    },
    useRef: (init: unknown) => slot(() => ({ current: init })),
    useMemo: (fn: () => unknown) => fn(),
    useEffect: () => undefined,
    useTransition: () => [false, (cb: () => unknown) => void cb()],
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/appointments/actions", () => ({
  addInspectionPhotos: h.addInspectionPhotos,
  removeInspectionPhoto: vi.fn(async (id: string, path: string) => {
    h.doorRemoves.push([id, path]);
    return { ok: true };
  }),
  saveInspectionAnswers: vi.fn(async () => ({ ok: true })),
  saveInspectionCapture: h.saveCapture,
  setAppointmentPlace: vi.fn(async () => ({ ok: true })),
  linkAppointmentTo: vi.fn(),
  searchLinkTargets: vi.fn(async () => []),
}));
vi.mock("@/app/(app)/jobs/actions", () => ({ addDocument: h.addDocument }));
vi.mock("@/app/(app)/appointments/hear-actions", () => ({ hearIntoPlaybook: vi.fn() }));
vi.mock("@/app/(app)/forms/actions", () => ({ createStarterInspectionSheet: vi.fn() }));
vi.mock("@/components/address-autocomplete", () => ({ AddressAutocomplete: () => null }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: async (path: string) => {
          h.uploads.push(path);
          return { error: h.uploadError };
        },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://example.invalid/${path.split("/").pop()}` } }),
        copy: async (from: string, to: string) => {
          h.copies.push([from, to]);
          return { error: h.copyError };
        },
        remove: async (paths: string[]) => {
          h.removes.push(paths);
          return { error: null };
        },
      }),
    },
  }),
}));
// The page sees a phone that can scan; the camera and the shell's discard are the mocks. The real
// module is kept for everything else (the kept-model rules are the code under test).
vi.mock("@/lib/native-scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/native-scan")>()),
  NO_SCAN_DOORS: { model: true },
  scanDoors: async () => ({ model: true }),
  scan3dNative: h.scan3dNative,
  discardScan: h.discardScan,
}));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => h.shell }));

import { Inspector } from "@/app/(app)/appointments/[id]/inspector";
import { DISCARD_KEPT_LABEL, jobFilingWords, keptElsewhereWords, keptStep, keptWords, MODEL_LOST_WORDS, pullFile, type KeptModel } from "@/lib/native-scan";

/** The page's view of the module has the camera swapped out; the bridge itself is the real one. */
const realScan3dNative = async (now?: number) => (await vi.importActual<typeof import("@/lib/native-scan")>("@/lib/native-scan")).scan3dNative(now);

const SRC = readFileSync("src/app/(app)/appointments/[id]/inspector.tsx", "utf8");
const SCAN = readFileSync("src/lib/native-scan.ts", "utf8");

const SHEET = {
  id: "sheet-1",
  name: "Site walk",
  schema: [],
  playbook: {
    needs: [{ key: "tasks", label: "Tasks", ask: "What are the tasks?", slot: { type: "tasks" } }],
  },
};
const ANSWERS = { tasks: [{ id: "t1", name: "Hood outlet", hours: 2, units: null, kit_id: null, materials: [] }] };

type El = { type?: unknown; props?: { id?: string; children?: unknown; onClick?: () => unknown; disabled?: boolean } };
const isEl = (n: unknown): n is El => !!n && typeof n === "object" && "props" in n;
function walk(n: unknown, at: string, f: (e: El, at: string) => void) {
  if (Array.isArray(n)) return n.forEach((c) => walk(c, at, f));
  if (!isEl(n)) return;
  const here = typeof n.props?.id === "string" ? n.props.id : at;
  f(n, here);
  walk(n.props?.children, here, f);
}
const textOf = (n: unknown): string => (Array.isArray(n) ? n.map(textOf).join("") : typeof n === "string" || typeof n === "number" ? String(n) : isEl(n) ? textOf(n.props?.children) : "");

const PROPS = {
  appointmentId: "appt-1",
  orgId: "org-1",
  userId: "u-1",
  templates: [SHEET],
  priceBook: [],
  initialTemplateId: "sheet-1",
  initialAnswers: ANSWERS,
  // a measurement on the visit, so the visit's own Lidar group is drawn beside the task's
  initialCapture: { photos: [], measures: [{ id: "m1", label: "Panel wall", value: 4, unit: "ft" }] },
  initialPhotos: [],
  initialLocation: "",
  linked: { kind: "lead", name: "Larkspur" },
  estimateHref: null,
  access: "office",
  initialOpenTaskId: "t1",
};
let jobId: string | null = null;
const frame = () => {
  h.i = 0;
  return (Inspector as unknown as (p: unknown) => unknown)({ ...PROPS, jobId });
};
/** The buttons named `name`, each with the id of the box it sits in: the task's Lidar group, or the visit's. */
function buttons(name: string): Array<{ el: El; in: string }> {
  const out: Array<{ el: El; in: string }> = [];
  walk(frame(), "", (e, at) => {
    if (e.props?.onClick && textOf(e.props.children).trim() === name) out.push({ el: e, in: at });
  });
  return out;
}
const taskScan = () => buttons("3D Scan").find((b) => b.in === "task-measure-t1")!.el;
const visitScan = () => buttons("3D Scan").find((b) => b.in === "insp-measures")!.el;
const discardButton = () => buttons(DISCARD_KEPT_LABEL)[0]?.el;
/** The trash can on each tile of the visit's photo grid (the office's Remove). */
const removeTile = () => {
  const out: El[] = [];
  walk(frame(), "", (e, at) => {
    if (e.type === "button" && at === "insp-photos" && e.props?.onClick) out.push(e);
  });
  return out;
};
const page = () => textOf(frame());
/** Let every awaited mock finish (they all resolve at once; the timers are fake so nothing else fires). */
const settle = async () => {
  for (let k = 0; k < 60; k++) await Promise.resolve();
};
const tap = async (el: El | undefined) => {
  expect(el, "that button is not on the page").toBeTruthy();
  el!.props!.onClick!();
  await settle();
};
const model = () => new File([new Uint8Array(64)], "scan-3d-1.usdz", { type: "model/vnd.usdz+zip" });
const scanned = () => ({ ok: true, kind: "model", model: model(), path: "/tmp/north-scans/model-a.usdz", shots: 30 });
const photosSaved = () => h.saveCapture.mock.calls.map((c) => (c[1] as { photos: string[] }).photos);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  h.hooks.length = 0;
  h.uploads.length = 0;
  h.removes.length = 0;
  h.doorRemoves.length = 0;
  h.copies.length = 0;
  h.uploadError = null;
  h.copyError = null;
  h.shell = false;
  jobId = null;
  h.scan3dNative.mockReset().mockImplementation(async () => scanned());
  h.discardScan.mockClear();
  h.saveCapture.mockReset().mockResolvedValue({ ok: true });
  h.addInspectionPhotos.mockReset().mockResolvedValue({ ok: true });
  h.addDocument.mockReset().mockResolvedValue({ ok: true, id: "doc-1" });
  (globalThis as { confirm?: () => boolean }).confirm = () => true;
});
afterEach(() => {
  vi.useRealTimers();
});

const kept = (over: Partial<KeptModel> = {}): KeptModel => ({ model: model(), path: "/p", taskId: "t1", landed: null, ...over });

describe("3D Scan retry conflates 'row not saved' with 'file not uploaded', never binds the kept model to its task, and offers no way out of the resend loop", () => {
  it("the tap's step is told apart: scan, send the file again, save the row alone, or neither (another place)", () => {
    expect(keptStep(null, "t1")).toEqual({ step: "scan" });
    expect(keptStep(null, null)).toEqual({ step: "scan" });
    const k = kept();
    expect(keptStep(k, "t1")).toEqual({ step: "upload", kept: k });
    const up = kept({ landed: { path: "org-1/appointments/appt-1/1-scan.usdz", url: null } });
    expect(keptStep(up, "t1")).toEqual({ step: "row", kept: up });
    // the visit is a place of its own (null), never "any place"
    expect(keptStep(k, null).step).toBe("elsewhere");
    expect(keptStep(kept({ taskId: null }), "t1").step).toBe("elsewhere");
    expect(keptStep(kept({ taskId: null }), null).step).toBe("upload");
  });

  it("the two faults get two different last lines, each naming ONE action", () => {
    expect(keptWords(false)).toBe("It's kept on this phone — tap 3D Scan again to send it without scanning.");
    expect(keptWords(true)).toBe("The model is up on the visit, so tap 3D Scan again to save it.");
    for (const w of [keptWords(false), keptWords(true)]) expect(w.match(/tap 3D Scan again/g)?.length).toBe(1);
  });

  it("a file that did not upload is sent again on the next tap, with no camera, and the kept model clears once it is up", async () => {
    h.uploadError = { message: "Failed to fetch" };
    await tap(taskScan());
    expect(h.scan3dNative).toHaveBeenCalledTimes(1);
    expect(h.uploads).toHaveLength(1);
    expect(h.saveCapture).not.toHaveBeenCalled(); // never reached the row
    expect(page()).toContain("tap 3D Scan again to send it without scanning.");
    expect(discardButton()).toBeTruthy();
    expect(h.discardScan).not.toHaveBeenCalled(); // the shell keeps its copy while the file has not gone up
    h.uploadError = null;
    await tap(taskScan());
    expect(h.scan3dNative).toHaveBeenCalledTimes(1); // no second walk
    expect(h.uploads).toHaveLength(2); // the FILE failed, so the file goes again
    expect(photosSaved()).toHaveLength(1);
    expect(discardButton()).toBeUndefined();
    expect(h.discardScan).toHaveBeenCalledWith("/tmp/north-scans/model-a.usdz");
  });

  it("a refusal that never changes is not a loop: Discard Kept 3D Model lets go, and the next tap scans", async () => {
    h.uploadError = { message: "new row violates row-level security policy" };
    await tap(taskScan());
    await tap(taskScan());
    await tap(taskScan());
    expect(h.scan3dNative).toHaveBeenCalledTimes(1); // three taps, one walk: this is the loop
    expect(h.uploads).toHaveLength(3);
    await tap(discardButton());
    expect(discardButton()).toBeUndefined();
    expect(h.discardScan).toHaveBeenCalledWith("/tmp/north-scans/model-a.usdz");
    await tap(taskScan());
    expect(h.scan3dNative).toHaveBeenCalledTimes(2); // the camera opens again
  });

  it("Discard asks first (minutes of walking), and a No keeps the model", async () => {
    h.uploadError = { message: "Failed to fetch" };
    await tap(taskScan());
    (globalThis as { confirm?: () => boolean }).confirm = () => false;
    await tap(discardButton());
    expect(discardButton()).toBeTruthy();
    expect(h.discardScan).not.toHaveBeenCalled();
    expect(SRC).toContain('if (!confirm("Discard the kept 3D model? The room would need scanning again.")) return;');
  });

  it("the button is Title Case, the same one the removed-task sentence names, and sits beside 3D Scan", () => {
    expect(DISCARD_KEPT_LABEL).toBe("Discard Kept 3D Model");
    expect(keptElsewhereWords(null)).toContain(`Tap ${DISCARD_KEPT_LABEL}.`);
    expect(SRC).toContain("{DISCARD_KEPT_LABEL}");
    expect(SRC).toContain("{keptModel && (");
  });
});

describe("A kept 3D model is re-sent onto whichever task is tapped next, and there is no way to discard it", () => {
  it("a model kept for a task is not sent to the visit: no camera, no upload, and the sentence says where it waits", async () => {
    h.uploadError = { message: "Failed to fetch" };
    await tap(taskScan());
    h.uploadError = null;
    const before = h.uploads.length;
    await tap(visitScan());
    expect(h.scan3dNative).toHaveBeenCalledTimes(1);
    expect(h.uploads).toHaveLength(before); // the old room's model did not go anywhere
    expect(page()).toContain('The 3D model scanned for "Hood outlet" is still waiting to send. Tap 3D Scan there to send it.');
    expect(discardButton()).toBeTruthy(); // and it is still kept
    // back where it belongs, it goes
    await tap(taskScan());
    expect(h.uploads).toHaveLength(before + 1);
    expect(discardButton()).toBeUndefined();
  });

  it("a model kept for the visit is not sent onto a task", async () => {
    h.uploadError = { message: "Failed to fetch" };
    await tap(visitScan());
    h.uploadError = null;
    const before = h.uploads.length;
    await tap(taskScan());
    expect(h.uploads).toHaveLength(before);
    expect(h.scan3dNative).toHaveBeenCalledTimes(1);
    expect(page()).toContain("The 3D model scanned for the visit is still waiting to send. Tap 3D Scan there to send it.");
  });

  it("when it is discarded, a tap anywhere scans fresh and the new model lands on the tapped place", async () => {
    h.uploadError = { message: "Failed to fetch" };
    await tap(taskScan());
    h.uploadError = null;
    await tap(discardButton());
    await tap(visitScan());
    expect(h.scan3dNative).toHaveBeenCalledTimes(2);
    expect(h.uploads).toHaveLength(2); // the first try, and the new model's
    expect(photosSaved()).toHaveLength(1);
  });

  it("the sentences: a place in words, the visit, and a task that was removed (where only Discard is left)", () => {
    expect(keptElsewhereWords("the visit")).toBe("The 3D model scanned for the visit is still waiting to send. Tap 3D Scan there to send it.");
    expect(keptElsewhereWords('"Garage"')).toBe('The 3D model scanned for "Garage" is still waiting to send. Tap 3D Scan there to send it.');
    expect(keptElsewhereWords(null)).toBe("The kept 3D model was scanned for a task that has been removed. Tap Discard Kept 3D Model.");
    // the door looks the task up by its id and names a nameless one as the sheet does
    expect(SRC).toContain('const t = at === null ? null : tasksNow().find((x) => x.id === at);');
    expect(SRC).toContain('setError(keptElsewhereWords(at === null ? "the visit" : t ? `"${t.name.trim() || "A task with no name yet"}"` : null));');
  });

  it("the elsewhere refusal happens before the camera could open or the busy flag is taken", () => {
    const door = SRC.slice(SRC.indexOf("async function scan3dInto("), SRC.indexOf("async function dropKept("));
    expect(door.indexOf('step.step === "elsewhere"')).toBeLessThan(door.indexOf("measuringRef.current = true;"));
    expect(door.indexOf('step.step === "elsewhere"')).toBeLessThan(door.indexOf("await scan3dNative()"));
  });
});

describe("If the row save fails after the 3D upload, the retry uploads a second copy", () => {
  it("the row failing leaves the file up: the next tap saves the row alone, with no second upload and no second tile", async () => {
    h.saveCapture.mockReset().mockResolvedValueOnce({ ok: false, error: "Couldn't save the photos right now." }).mockResolvedValue({ ok: true });
    await tap(taskScan());
    expect(h.uploads).toHaveLength(1);
    expect(h.saveCapture).toHaveBeenCalledTimes(1);
    expect(page()).toContain("Couldn't save the photos right now. The model is up on the visit, so tap 3D Scan again to save it.");
    expect(discardButton()).toBeTruthy();
    // the model is safe in storage, so the phone's copy goes now, not on a later scan's sweep
    expect(h.discardScan).toHaveBeenCalledWith("/tmp/north-scans/model-a.usdz");
    await tap(taskScan());
    expect(h.scan3dNative).toHaveBeenCalledTimes(1);
    expect(h.uploads).toHaveLength(1); // THE FILE WENT UP ONCE
    expect(h.saveCapture).toHaveBeenCalledTimes(2);
    expect(photosSaved()[1]).toEqual([h.uploads[0]]); // one path, in the list, once
    expect(discardButton()).toBeUndefined();
  });

  it("a save that THROWS (a dead zone mid-save) is the same fault: the file is up, only the row is owed", async () => {
    h.saveCapture.mockReset().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue({ ok: true });
    await tap(taskScan());
    expect(h.uploads).toHaveLength(1);
    expect(page()).toContain("Couldn't save the photos. The model is up on the visit, so tap 3D Scan again to save it.");
    expect(page()).not.toContain("didn't go");
    await tap(taskScan());
    expect(h.uploads).toHaveLength(1);
    expect(photosSaved()[1]).toEqual([h.uploads[0]]);
  });

  it("an ordinary photo whose row save throws keeps its own sentence and action (try again): the 3D model's wording is the model's only", async () => {
    h.saveCapture.mockReset().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue({ ok: true });
    let pick: ((e: unknown) => void) | undefined;
    walk(frame(), "", (e) => {
      const p = e.props as { type?: string; onChange?: (x: unknown) => void } | undefined;
      if (e.type === "input" && p?.type === "file" && p.onChange && !pick) pick = p.onChange;
    });
    expect(pick, "the photo picker is on the page").toBeTruthy();
    pick!({ target: { files: [new File([new Uint8Array(8)], "plan.pdf", { type: "application/pdf" })], value: "" } });
    await settle();
    expect(h.uploads).toHaveLength(1);
    expect(page()).toContain("didn't go: no signal. Try again where there's service.");
    expect(page()).not.toContain("tap 3D Scan again");
  });

  it("a crew lead's row-only retry sends just that one path, appended on the server", async () => {
    const lead = () => {
      h.i = 0;
      return (Inspector as unknown as (p: unknown) => unknown)({ ...PROPS, access: "crewLead", jobId });
    };
    const find = () => {
      const out: Array<{ el: El; in: string }> = [];
      walk(lead(), "", (e, at) => {
        if (e.props?.onClick && textOf(e.props.children).trim() === "3D Scan") out.push({ el: e, in: at });
      });
      return out.find((b) => b.in === "task-measure-t1")?.el;
    };
    h.addInspectionPhotos.mockReset().mockResolvedValueOnce({ ok: false, error: "No signal." }).mockResolvedValue({ ok: true });
    await tap(find());
    await tap(find());
    expect(h.uploads).toHaveLength(1);
    expect(h.addInspectionPhotos).toHaveBeenCalledTimes(2);
    expect(h.addInspectionPhotos.mock.calls[1]).toEqual(["appt-1", [h.uploads[0]]]);
  });

  it("Discard on a model that is up but unsaved takes the whole thing back: the tile, and the file in storage", async () => {
    h.saveCapture.mockReset().mockResolvedValueOnce({ ok: false, error: "Couldn't save the photos right now." }).mockResolvedValue({ ok: true });
    await tap(taskScan());
    const up = h.uploads[0];
    expect(removeTile().length).toBeGreaterThan(0); // the tile is on the page
    await tap(discardButton());
    expect(h.doorRemoves).toEqual([["appt-1", up]]); // through the door, never storage directly
    expect(h.removes).toEqual([]);
    expect(removeTile()).toHaveLength(0);
    expect(discardButton()).toBeUndefined();
    // and the next scan's save does not carry the discarded path back in
    await tap(taskScan());
    expect(h.scan3dNative).toHaveBeenCalledTimes(2);
    expect(photosSaved().at(-1)).not.toContain(up);
  });

  it("removing the tile of that model with the tile's own Remove lets go of the kept model too, or the next tap would put it back", async () => {
    h.saveCapture.mockReset().mockResolvedValueOnce({ ok: false, error: "Couldn't save the photos right now." }).mockResolvedValue({ ok: true });
    await tap(taskScan());
    const up = h.uploads[0];
    await tap(removeTile()[0]);
    expect(h.doorRemoves).toEqual([["appt-1", up]]); // through the door, never storage directly
    expect(h.removes).toEqual([]);
    expect(discardButton()).toBeUndefined();
    expect(removeTile()).toHaveLength(0);
  });

  it("upload() reads the two faults apart: the files that landed are told to the caller, and a kept file skips the loop", () => {
    const up = SRC.slice(SRC.indexOf("async function upload("), SRC.indexOf("function removePhoto("));
    expect(up).toContain("async function upload(files: File[], extra?: Partial<CapturePhotoMeta>, landed?: CapturePhoto[]): Promise<string[]> {");
    expect(up).toContain("if (!files.length && !landed?.length) return stored;");
    expect(up).toContain("const added: CapturePhoto[] = [...(landed ?? [])];");
    expect(up).toContain("uploadLandedRef.current = added; // the files are up; the row is what is owed");
    expect(up).toContain('if (extra?.about === "3D Scan" && sending === null && added.length && !stored.length) {');
    // the catch for a FILE is untouched
    expect(up).toContain("const r = uploadRefusal(e, {");
  });
});

describe("fileOnJob puts storage's raw error text into the sentence shown to the contractor", () => {
  it("storage's own sentence never reaches him: the copy is refused for access, in the app's words, with one action", async () => {
    jobId = "job-1";
    h.copyError = { message: "new row violates row-level security policy" };
    await tap(taskScan());
    expect(h.copies).toHaveLength(1);
    const p = page();
    expect(p).not.toContain("row-level");
    expect(p).not.toContain("violates");
    expect(p).toContain("The 3D model is on the visit, but it didn't file on the job: this login can't file there. Tell the office to file it.");
    expect(h.addDocument).not.toHaveBeenCalled();
  });

  it("a copy storage refuses for any other reason is not guessed at", async () => {
    jobId = "job-1";
    h.copyError = { message: "Object not found" };
    await tap(taskScan());
    expect(page()).toContain("The 3D model is on the visit, but it didn't file on the job. Tell the office to file it.");
    expect(page()).not.toContain("Object not found");
  });

  it("a dropped connection while the row is written is no signal, and the copy is taken back out of the job's folder", async () => {
    jobId = "job-1";
    h.addDocument.mockReset().mockRejectedValue(new TypeError("Failed to fetch"));
    await tap(taskScan());
    expect(page()).toContain("The 3D model is on the visit, but it didn't file on the job: no signal. Tell the office to file it.");
    expect(page()).not.toContain("Failed to fetch");
    expect(h.removes).toEqual([[h.copies[0][1]]]); // nothing orphaned in the job's folder
  });

  it("the app's own refusal of the row is read for its meaning, not repeated", async () => {
    jobId = "job-1";
    h.addDocument.mockReset().mockResolvedValue({ ok: false, error: "You don't have access to change that. If you think you should, ask an owner or admin." });
    await tap(taskScan());
    expect(page()).toContain("didn't file on the job: this login can't file there. Tell the office to file it.");
    h.addDocument.mockReset().mockResolvedValue({ ok: false });
    await tap(taskScan());
    expect(page()).toContain("didn't file on the job. Tell the office to file it.");
  });

  it("jobFilingWords: no signal, no access, and everything else said only as far as it is known", () => {
    for (const m of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource.", "fetch failed"]) {
      expect(jobFilingWords(new TypeError(m))).toBe("The 3D model is on the visit, but it didn't file on the job: no signal. Tell the office to file it.");
    }
    for (const m of ["new row violates row-level security policy", "Unauthorized", "permission denied for table documents", "Not signed in."]) {
      expect(jobFilingWords({ message: m })).toBe("The 3D model is on the visit, but it didn't file on the job: this login can't file there. Tell the office to file it.");
    }
    expect(jobFilingWords("You don't have access to change that.")).toContain("this login can't file there");
    for (const e of [{ message: "Something odd" }, null, undefined, {}, 7]) {
      expect(jobFilingWords(e)).toBe("The 3D model is on the visit, but it didn't file on the job. Tell the office to file it.");
    }
  });

  it("the page no longer interpolates an error's message into a sentence it shows", () => {
    const fn = SRC.slice(SRC.indexOf("async function fileOnJob("), SRC.indexOf("// THE LIDAR GROUP"));
    expect(fn).not.toContain("copyErr.message");
    expect(fn).not.toContain("the connection dropped");
    expect(fn).toContain("jobFilingWords(copyErr)");
    expect(fn).toContain("jobFilingWords(failed.why)");
  });
});

describe("A model that fails to come over the bridge is orphaned in the phone's temp folder, and the sentence promises a retry that is a full new walk", () => {
  function shell(plugin: Record<string, unknown>) {
    const g = globalThis as unknown as { window?: unknown; atob?: unknown };
    const prev = { window: g.window, atob: g.atob };
    h.shell = true;
    g.window = { Capacitor: { Plugins: { Scan: plugin } } };
    if (!g.atob) g.atob = (b: string) => Buffer.from(b, "base64").toString("binary");
    return () => {
      h.shell = false;
      g.window = prev.window;
      g.atob = prev.atob;
    };
  }
  const file = (total: number, readChunk: () => Promise<{ data?: unknown; bytes?: unknown; total?: unknown }>) => {
    const discarded: string[] = [];
    return {
      discarded,
      plugin: {
        scan3d: async () => ({ ok: true, kind: "model", path: "/tmp/north-scans/model-big.usdz", bytes: total }),
        readChunk,
        discard: async ({ path }: { path: string }) => void discarded.push(path),
      },
    };
  };

  it("two failed pieces: the shell's copy goes at once, and the sentence says the model is lost with the one action, a new scan", async () => {
    const f = file(100_000_000, async () => {
      throw new Error("bridge hiccup");
    });
    const off = shell(f.plugin);
    try {
      const r = await realScan3dNative();
      expect(r).toEqual({ ok: false, refused: MODEL_LOST_WORDS });
      expect(f.discarded).toEqual(["/tmp/north-scans/model-big.usdz"]); // not left for a later scan's sweep
    } finally {
      off();
    }
  });

  it("the sentence promises no retry (a retry is a whole new walk): lost, and Tap 3D Scan to scan again", () => {
    expect(MODEL_LOST_WORDS).toBe("The model didn't come over from the camera whole, so it's lost. Tap 3D Scan to scan again.");
    expect(MODEL_LOST_WORDS).not.toMatch(/retry/i);
    expect(SCAN).not.toContain("Tap 3D Scan again to retry");
    expect(MODEL_LOST_WORDS.match(/Tap 3D Scan/g)?.length).toBe(1);
  });

  it("a piece that comes short is lost the same way; a whole model is not discarded by the pull", async () => {
    const short = file(10, async () => ({ data: "", bytes: 0, total: 10 }));
    const off = shell(short.plugin);
    try {
      expect(await realScan3dNative()).toEqual({ ok: false, refused: MODEL_LOST_WORDS });
      expect(short.discarded).toHaveLength(1);
    } finally {
      off();
    }
    const whole = file(5, async () => ({ data: Buffer.from([1, 2, 3, 4, 5]).toString("base64"), bytes: 5, total: 5 }));
    const off2 = shell(whole.plugin);
    try {
      const r = await realScan3dNative(7);
      expect(r.ok && r.kind === "model" && r.model.size === 5).toBe(true);
      expect(whole.discarded).toEqual([]); // the page discards it once the upload has landed
      // and pullFile itself never discards, whoever calls it
      expect(await pullFile({ ...whole.plugin }, "/p", 0, "a.usdz", "x")).toBeNull();
      expect(whole.discarded).toEqual([]);
    } finally {
      off2();
    }
  });

  it("pullFile's own comment no longer says the shell's copy is taken later by a path nothing holds", () => {
    expect(SCAN).not.toContain("the shell's copy is left where it is (discardScan takes it later)");
    expect(SCAN).toContain("It never discards: the caller owns the shell's copy");
    const door = SCAN.slice(SCAN.indexOf("const model = await pullFile(p, path, total"), SCAN.indexOf("return { ok: true, kind: \"model\""));
    expect(door.indexOf("await discardScan(path);")).toBeGreaterThan(-1);
    expect(door.indexOf("await discardScan(path);")).toBeLessThan(door.indexOf("refused: MODEL_LOST_WORDS"));
  });
});
