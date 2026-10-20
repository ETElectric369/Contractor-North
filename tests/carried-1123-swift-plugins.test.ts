import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CARRIED FROM audit v1120 (fix wave cn-v1123): the native plugins' promises settle on every path.
 * Swift cannot run under vitest, so these are source pins on the exact lines that close each hole
 * (the way field-1016-scan3d.test.ts pins ScanPlugin); each was absent before the fix.
 */
const ROOT = path.resolve(__dirname, "..");
const measure = readFileSync(path.join(ROOT, "ios/App/App/MeasurePlugin.swift"), "utf8");
const scan = readFileSync(path.join(ROOT, "ios/App/App/ScanPlugin.swift"), "utf8");

/** The text from `start` up to (not including) the first `end` after it. */
function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `missing: ${start}`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `missing end: ${end}`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("Measure can be left on a frozen full-screen camera with dead buttons and a promise that never answers", () => {
  const finish = between(measure, "    private func finish(_ outcome: MeasureOutcome) {", "    // MARK: - The figure");

  it("an outcome decided before the screen is up waits for viewDidAppear (UIKit drops a dismiss mid-animation)", () => {
    expect(measure).toContain("private var appeared = false");
    expect(measure).toContain("private var pendingOutcome: MeasureOutcome?");
    expect(measure).toContain(
      "override func viewDidAppear(_ animated: Bool) {\n        super.viewDidAppear(animated)\n        appeared = true\n        if let pendingOutcome {\n            self.pendingOutcome = nil\n            finish(pendingOutcome)\n        }\n    }",
    );
    // The latch comes BEFORE `finished = true`: finished stays false while the outcome is held, so
    // Cancel and the 1.5 s watchdog still work on a screen that has not come up.
    expect(finish.indexOf("guard appeared else {")).toBeGreaterThan(0);
    expect(finish.indexOf("guard appeared else {")).toBeLessThan(finish.indexOf("finished = true"));
  });

  it("a failure inside the animation stops the camera and the buttons at once, then answers once it is up", () => {
    const held = between(finish, "guard appeared else {", "        finished = true");
    expect(held).toContain("pendingOutcome = outcome");
    expect(held).toContain("sceneView.session.pause()");
    expect(held).toContain("view.isUserInteractionEnabled = false");
  });

  it("the dismissal is the presenter's, and a screen already off the stack answers directly instead of waiting on a completion UIKit never runs", () => {
    expect(finish).toContain("guard let presenter = presentingViewController else {\n            done(outcome)\n            return\n        }");
    expect(finish).toContain("presenter.dismiss(animated: true) { [done] in done(outcome) }");
    expect(finish).not.toContain("\n        dismiss(animated: true)");
  });

  it("keeps what field-1016-measure pins: the watchdog's sentence and the cancel resolution", () => {
    expect(measure).toContain('call.reject("Measure couldn\'t open over this screen. Close what\'s open and try again.")');
    expect(measure).toContain('call.resolve(["ok": false, "cancelled": true])');
  });
});

describe("Open In AR can hang forever and block every later model", () => {
  const fn = between(scan, "    @objc func previewFile(_ call: CAPPluginCall) {", "    /// One scan on screen at a time");

  it("a screen mid-way in or out is answered in words, not presented over blind", () => {
    expect(fn).toContain("guard !top.isBeingDismissed, !top.isBeingPresented else {\n                call.reject(Self.couldNotOpenModel)\n                return\n            }");
    expect(fn.indexOf("isBeingPresented")).toBeLessThan(fn.indexOf("self.preview = preview"));
    expect(scan).toContain('static let couldNotOpenModel = "Open In AR couldn\'t open over this screen. Close what\'s open and try again."');
  });

  it("a present UIKit refused is said after 1.5 s and frees the next model", () => {
    const timer = between(fn, "DispatchQueue.main.asyncAfter(deadline: .now() + 1.5)", "        }\n    }");
    expect(timer).toContain("preview.controller.presentingViewController == nil, preview.claim()");
    expect(timer).toContain("self.preview = nil");
    expect(timer).toContain("call.reject(Self.couldNotOpenModel)");
  });

  it("the call is answered ONCE, by whoever gets there first (the user's close, a dismissal from outside, or the timer)", () => {
    const model = between(scan, "final class ModelPreview: NSObject", "final class ModelPreviewController");
    expect(model).toContain("func claim() -> Bool {\n        guard !done else { return false }\n        done = true\n        return true\n    }");
    expect(model).toContain("func previewControllerDidDismiss(_ controller: QLPreviewController) { dismissed() }");
    expect(model).toContain("private func dismissed() {\n        guard claim() else { return }\n        closed()\n    }");
    expect(model).toContain("controller.gone = { [weak self] in self?.dismissed() }");
  });

  it("a dismissal Quick Look's delegate never hears (the stack under it taken down) is heard anyway", () => {
    const sub = scan.slice(scan.indexOf("final class ModelPreviewController: QLPreviewController {"));
    expect(sub).toContain("override func viewDidDisappear(_ animated: Bool) {");
    expect(sub).toContain("if isBeingDismissed || presentingViewController == nil { gone?() }");
  });
});

describe("Open In AR: previewFile can hang forever with a stuck Open In AR button, and the viewer re-downloads the whole model it already drew", () => {
  // The Swift half: the shell side never leaves the page's call (and its button) pending, and a
  // refused present leaves no staged copy behind. (The page-side half, the viewer fetching the
  // bytes once and drawing from them, lives in src/components/model-viewer.tsx.)
  it("a present that never came up removes the staged copy before it rejects", () => {
    const fn = between(scan, "    @objc func previewFile(_ call: CAPPluginCall) {", "    /// One scan on screen at a time");
    const timer = fn.slice(fn.indexOf("DispatchQueue.main.asyncAfter(deadline: .now() + 1.5)"));
    expect(timer.indexOf("try? FileManager.default.removeItem(at: url)")).toBeGreaterThan(0);
    expect(timer.indexOf("try? FileManager.default.removeItem(at: url)")).toBeLessThan(timer.indexOf("call.reject(Self.couldNotOpenModel)"));
  });

  it("the viewer fetches the bytes ONCE: the loader draws from them (a blob URL, told where the sheets live) and Open In AR reuses them", () => {
    const v = readFileSync(path.join(ROOT, "src/components/model-viewer.tsx"), "utf8");
    // one fetch helper, used by the loader's road and by Open In AR; the bytes are kept in bytesRef
    expect(v.split("await fetchModelBytes(url)").length - 1).toBe(2);
    expect(v).not.toContain("await fetch(url)\n        if");
    expect(v).toContain("const bytes = bytesRef.current ?? (await fetchModelBytes(url));");
    expect(v).toContain("bytesRef.current = bytes;");
    // the sheets beside the model are found by relative path, so the loader is told the ORIGINAL location
    expect(v).toContain("loader.setResourcePath(bare.slice(0, bare.lastIndexOf(\"/\") + 1));");
    // the blob URL is let go once the model is read, and a failed fetch falls back to the URL load
    expect(v).toContain("if (objectUrl) URL.revokeObjectURL(objectUrl);");
    expect(v).toContain("let drawFrom = url;");
    expect(v).toContain("object = await loader.loadAsync(drawFrom);");
    expect(v.indexOf("bytesRef.current = bytes;")).toBeLessThan(v.indexOf("object = await loader.loadAsync(drawFrom);"));
  });

  it("the normal close still removes the file and resolves (pinned by field-1016-scan3d)", () => {
    expect(scan).toContain("try? FileManager.default.removeItem(at: url)\n                call.resolve()");
  });

  it("stays on the device: no network from the plugin", () => {
    expect(scan).not.toMatch(/URLSession|URLRequest/);
    expect(measure).not.toMatch(/URLSession|URLRequest/);
  });
});

describe("readChunk uses FileHandle.readData(ofLength:), whose I/O failure is an uncatchable ObjC exception", () => {
  const fn = between(scan, "    @objc func readChunk(_ call: CAPPluginCall) {", "    /// The page has the bytes");

  it("reads with the throwing API so a failed read reaches the catch", () => {
    expect(fn).toContain("let data = try handle.read(upToCount: length) ?? Data()");
    expect(fn).not.toContain("handle.readData(");
    expect(scan).not.toContain("handle.readData(");
  });

  it("and the catch says it in words", () => {
    expect(fn).toContain('call.reject("Couldn\'t read the scan file (\\(error.localizedDescription)).")');
  });

  it("keeps the 2 MB piece (the page assembles them) and the own-file guard", () => {
    expect(fn).toContain('let length = min(max(1, call.getInt("length") ?? 2_000_000), 4_000_000)');
    expect(fn).toContain('call.reject("That file isn\'t a scan of this app\'s.")');
  });
});
