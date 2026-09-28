import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NORT'S HOST HAS NO BAR BUTTON (W1-09), AND TALK TO NORT STARTS HIM INSIDE THE TAP.
 *
 * Talk To Nort (the first row under Search Or Ask) dispatches cn:nort-talk; this component's
 * listener runs launch() in that dispatch, so speech.startListening() is still inside the user
 * gesture — iOS refuses a mic started any later (the old "mic never starts on iPhone" bug). The
 * listener is added once, so launch() must read the panel's open state from a ref: a closure over
 * `open` would be the first render's value forever.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/planner",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/app/(app)/assistant/assistant-chat", () => ({ AssistantChat: () => createElement("i", { "data-x": "chat" }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/tts", () => ({ unlockAudio: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => false, safeAreaTop: () => 0 }));
vi.mock("@/lib/native-tap", () => ({ standDownReaderForVoice: vi.fn(async () => undefined) }));
vi.mock("@/lib/voice", () => ({ startListening: vi.fn(() => true) }));
vi.mock("@/lib/estimator-store", () => ({ useEstimator: () => ({ draft: null, card: null, listening: true, streaming: true, speaking: true }) }));

import { GlobalAssistant } from "./global-assistant";
import { NORT_TALK_EVENT } from "@/lib/onboarding/help-rows";

const src = readFileSync(join(process.cwd(), "src/components/global-assistant.tsx"), "utf8");

describe("GlobalAssistant", () => {
  it("renders no control of its own, even while Nort is busy: Search Or Ask is the door, and it turns into Stop Nort", () => {
    const html = renderToStaticMarkup(createElement(GlobalAssistant));
    expect(html).not.toContain("<button");
  });

  it("listens for cn:nort-talk, a NEW event (cn:assistant-talk already means resume, inside the panel)", () => {
    expect(NORT_TALK_EVENT).toBe("cn:nort-talk");
    expect(src).toContain("window.addEventListener(NORT_TALK_EVENT, onTalk)");
    expect(src).toContain('window.dispatchEvent(new Event("cn:assistant-talk"))');
  });

  it("runs launch() in the same call stack: no timer, promise or await between the event and the mic", () => {
    const listener = src.slice(src.indexOf("const onTalk ="), src.indexOf("window.addEventListener(NORT_TALK_EVENT"));
    expect(listener).toContain("launchRef.current()");
    expect(listener).not.toMatch(/setTimeout|requestAnimationFrame|await|\.then\(|queueMicrotask/);
    // launch() itself starts the mic before anything asynchronous happens to it.
    const launch = src.slice(src.indexOf("function launch()"), src.indexOf("// W5 — the end-of-day debrief"));
    expect(launch).toContain("speech.startListening();");
    expect(launch.indexOf("speech.startListening();")).toBeLessThan(launch.indexOf("setOpen(true)"));
    expect(launch).not.toMatch(/await|setTimeout/);
  });

  it("reads the panel's open state from a ref, because the listener is added once", () => {
    const launch = src.slice(src.indexOf("function launch()"), src.indexOf("// W5 — the end-of-day debrief"));
    expect(launch).toContain("if (openRef.current)");
    expect(launch).not.toMatch(/if \(open\)/);
    // Every open/close goes through the one setter that keeps the ref in step.
    expect(src).toContain("openRef.current = v;");
    expect(src.match(/setOpenState\(/g)).toHaveLength(1);
  });
});
