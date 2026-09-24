import { describe, expect, it } from "vitest";
import { saveRoute } from "./shell-save";

/** The lightbox's Download in the iOS shell must never navigate the app's own WebView to the file
 *  (be3dca81). Browsers keep the plain download; the shell gets the share sheet or Safari. */
describe("saveRoute", () => {
  const ready = { fileReady: true, canShareFile: true, shareFailed: false };

  it("leaves the browser's own download alone outside the shell", () => {
    expect(saveRoute({ inShell: false, ...ready })).toBe("download");
    expect(saveRoute({ inShell: false, fileReady: false, canShareFile: false, shareFailed: true })).toBe("download");
  });

  it("uses the share sheet in the shell when the file is in hand and shareable", () => {
    expect(saveRoute({ inShell: true, ...ready })).toBe("share-sheet");
  });

  it("goes to Safari in the shell when the sheet can't take it", () => {
    expect(saveRoute({ inShell: true, ...ready, fileReady: false })).toBe("safari");
    expect(saveRoute({ inShell: true, ...ready, canShareFile: false })).toBe("safari");
    expect(saveRoute({ inShell: true, ...ready, shareFailed: true })).toBe("safari");
  });
});
