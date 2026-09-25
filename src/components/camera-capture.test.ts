import { describe, it, expect, vi } from "vitest";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE CAMERA MODAL ON SCREEN, phase by phase ("camera was black", Erik 2026-09-24). The shutter
 * is shut until a real picture arrives; a black capture gets a sentence, never Use Photo; a
 * camera that can't open says why; "Choose A Photo Instead" is there in every state; the picker
 * appears when there is more than one camera.
 */

vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn(async () => {}) }));

import { CameraCaptureView, DARK_PREVIEW_LINE, type CameraPhase } from "./camera-capture";
import { BLACK_FRAME_LINE, NO_FRAME_LINE, cameraFailureLine, type CameraOption } from "@/lib/camera-frame";

const TWO: CameraOption[] = [
  { deviceId: "facetime", label: "FaceTime HD Camera" },
  { deviceId: "iphone", label: "Erik’s iPhone Camera" },
];

function render(
  phase: CameraPhase,
  over: Partial<{ message: string | null; darkHint: boolean; cameras: CameraOption[]; cameraId: string | null; shotUrl: string | null }> = {},
) {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(CameraCaptureView, {
      phase,
      message: null,
      darkHint: false,
      cameras: [],
      cameraId: null,
      shotUrl: null,
      videoRef: createRef<HTMLVideoElement>(),
      fileInputRef: createRef<HTMLInputElement>(),
      onSnap: noop,
      onRetake: noop,
      onUse: noop,
      onTryAgain: noop,
      onPickCamera: noop,
      onChooseFile: noop,
      onClose: noop,
      ...over,
    }),
  );
}

/** The <button> whose text contains `label`, as markup. */
function button(html: string, label: string): string | null {
  for (const m of html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)) {
    if (m[0].replace(/<[^>]+>/g, "").includes(label)) return m[0];
  }
  return null;
}
const isDisabled = (b: string | null) => !!b && /\sdisabled=""/.test(b);

describe("CameraCaptureView", () => {
  it("starting: the shutter is SHUT and says it's waiting, and the photo door is already open", () => {
    const html = render("starting");
    expect(html).toContain("Waiting for the camera…");
    expect(isDisabled(button(html, "Capture"))).toBe(true);
    expect(button(html, "Choose A Photo Instead")).not.toBeNull();
    expect(isDisabled(button(html, "Choose A Photo Instead"))).toBe(false);
    expect(html).not.toContain("Use Photo");
    // The video is mounted from the start, muted and inline, so WebKit will play it.
    expect(html).toMatch(/<video[^>]*autoplay=""[^>]*playsinline=""[^>]*muted=""/i);
  });

  it("live: the shutter opens", () => {
    const html = render("live");
    expect(button(html, "Capture")).not.toBeNull();
    expect(isDisabled(button(html, "Capture"))).toBe(false);
    expect(html).not.toContain("Waiting for the camera");
  });

  it("live but black for a while: says so, and the shutter stays open", () => {
    const html = render("live", { darkHint: true });
    expect(html).toContain(DARK_PREVIEW_LINE);
    expect(isDisabled(button(html, "Capture"))).toBe(false);
  });

  it("refused (a black capture): the sentence, Try Again, and NO Use Photo", () => {
    const html = render("refused", { message: BLACK_FRAME_LINE });
    expect(html).toContain("The camera sent a black picture. Try another camera or choose a photo instead.");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Use Photo");
    expect(button(html, "Try Again")).not.toBeNull();
    expect(button(html, "Choose A Photo Instead")).not.toBeNull();
    // A refused capture is never laid over the preview as if it were the picture.
    expect(html).not.toContain('alt="Captured"');
  });

  it("encoding: Retake is there and Use Photo waits (never a silent no-op)", () => {
    const html = render("encoding");
    expect(html).toContain("Saving the picture…");
    expect(isDisabled(button(html, "Use Photo"))).toBe(true);
    expect(isDisabled(button(html, "Retake"))).toBe(false);
  });

  it("shot: the picture over the (still mounted) video, with Retake and Use Photo", () => {
    const html = render("shot", { shotUrl: "blob:https://app/1" });
    expect(html).toContain('src="blob:https://app/1"');
    expect(html).toContain("<video");
    expect(isDisabled(button(html, "Use Photo"))).toBe(false);
    expect(button(html, "Retake")).not.toBeNull();
    expect(html).not.toContain("Capture</button>");
  });

  it("failed (the camera wouldn't open): the reason in plain words, Try Again, Close, and the photo door", () => {
    const line = cameraFailureLine("NotAllowedError");
    const html = render("failed", { message: line });
    expect(html.replace(/&#x27;/g, "'")).toContain(line);
    expect(button(html, "Try Again")).not.toBeNull();
    expect(button(html, "Close")).not.toBeNull();
    expect(button(html, "Choose A Photo Instead")).not.toBeNull();
    expect(html).not.toContain("Use Photo");
  });

  it("failed (no picture ever arrived): says so", () => {
    expect(render("failed", { message: NO_FRAME_LINE })).toContain("The camera never sent a picture.");
  });

  it("one camera: no picker", () => {
    expect(render("live", { cameras: [TWO[0]], cameraId: "facetime" })).not.toContain("<select");
  });

  it("two cameras: a picker with the system's labels, the open one selected", () => {
    const html = render("live", { cameras: TWO, cameraId: "iphone" });
    expect(html).toContain("<select");
    expect(html).toContain("FaceTime HD Camera");
    expect(html).toContain("Erik’s iPhone Camera");
    expect(html).toMatch(/<option value="iphone" selected="">/);
  });

  it("the picker is offered where it can help: a black capture and a failed camera", () => {
    expect(render("refused", { cameras: TWO, cameraId: "iphone", message: BLACK_FRAME_LINE })).toContain("<select");
    expect(render("failed", { cameras: TWO, message: NO_FRAME_LINE })).toContain("<select");
  });

  it("the picker hides while a capture is on screen", () => {
    expect(render("shot", { cameras: TWO, cameraId: "iphone", shotUrl: "blob:x" })).not.toContain("<select");
    expect(render("encoding", { cameras: TWO, cameraId: "iphone" })).not.toContain("<select");
  });

  it("the photo door is an image file input with no capture attribute (a file, not another camera)", () => {
    for (const phase of ["starting", "live", "encoding", "shot", "refused", "failed"] as CameraPhase[]) {
      const html = render(phase, { message: phase === "failed" || phase === "refused" ? "x" : null });
      expect(button(html, "Choose A Photo Instead")).not.toBeNull();
      const input = html.match(/<input[^>]*type="file"[^>]*>/)?.[0] ?? "";
      expect(input).toContain('accept="image/*"');
      expect(input).not.toContain("capture");
    }
  });

  it("a short screen (a phone on its side) can reach Capture: the dialog scrolls and nothing in it shrinks", () => {
    const html = render("live", { cameras: TWO, cameraId: "iphone", darkHint: true });
    const dialog = html.match(/<div role="dialog"[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(dialog).toMatch(/\boverflow-y-auto\b/);
    expect(dialog).not.toMatch(/\boverflow-hidden\b/);
    // Every direct section of the dialog keeps its height, so the video can't spill over the
    // picker and the button row can't be squeezed out of reach.
    for (const cls of [
      /class="[^"]*\bshrink-0\b[^"]*items-center justify-between/, // header
      /class="relative [^"]*\bshrink-0\b/, // the video box
      /<p role="status" class="[^"]*\bshrink-0\b/, // the dark-preview line
      /class="flex shrink-0 flex-col gap-2/, // picker + Capture + Choose A Photo Instead
    ]) {
      expect(html).toMatch(cls);
    }
  });

  it("Title Case and 44px: the close is a labelled 44px icon, the rest are h-11 or taller", () => {
    const html = render("failed", { message: "x", cameras: TWO });
    expect(html).toContain("Take A Photo");
    const close = html.match(/<button[^>]*aria-label="Close"[^>]*>/)?.[0] ?? "";
    expect(close).toMatch(/class="[^"]*\bh-11 w-11\b/);
    for (const m of html.matchAll(/<button[^>]*class="([^"]*)"/g)) expect(m[1]).toMatch(/\bh-1[12]\b/);
    expect(html).toMatch(/<select[^>]*class="[^"]*h-11/);
  });
});
