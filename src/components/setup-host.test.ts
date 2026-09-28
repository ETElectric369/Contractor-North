import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SETUP HOST (W1-09): the graduation cap's screens with no button of their own, mounted ONCE in
 * the app layout and opened by the setup rows through cn:setup — so closing the sheet a row sat in
 * (Search Or Ask, or the avatar menu) never kills a running lesson.
 */
vi.mock("@/components/setup-interview", () => ({ SetupInterview: () => createElement("i", { "data-x": "interview" }) }));
vi.mock("@/components/tour/tour-driver", () => ({ TourDriver: () => createElement("i", { "data-x": "driver" }) }));
vi.mock("@/components/ui/modal", () => ({ Modal: () => null }));

import { SetupHost, screenFor } from "./setup-host";
import { ALL_ON, type FeatureMap } from "@/lib/features";

const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("what each setup row opens", () => {
  it("tour, questions, finish — and with Nort off the tour opens the questions (the tour is Nort talking)", () => {
    expect(screenFor("tour", true)).toEqual({ mode: "tour", lessonKey: null });
    expect(screenFor("tour", false)).toEqual({ mode: "questions", lessonKey: null });
    expect(screenFor("questions", true)).toEqual({ mode: "questions", lessonKey: null });
    expect(screenFor("finish", false)).toEqual({ mode: "finish", lessonKey: null });
  });

  it("a lesson by key — only a real one, and only while its switch is on", () => {
    expect(screenFor("lesson:getting-around", true)).toEqual({ mode: null, lessonKey: "getting-around" });
    expect(screenFor("lesson:why-lines", true, off("leads"))).toEqual({ mode: null, lessonKey: "why-lines" });
    expect(screenFor("lesson:why-lines", true, off("leads", "estimates"))).toBeNull();
    expect(screenFor("lesson:nope", true)).toBeNull();
  });

  it("anything else is ignored rather than guessed", () => {
    for (const bad of [undefined, null, 7, "", "delete-everything", { mode: "tour" }]) expect(screenFor(bad, true)).toBeNull();
  });
});

describe("the host", () => {
  it("renders nothing for a tech (no setup rows reach him) and nothing for staff until a row asks", () => {
    expect(renderToStaticMarkup(createElement(SetupHost, { initial: {}, isStaff: false, onboarded: false }))).toBe("");
    expect(renderToStaticMarkup(createElement(SetupHost, { initial: {}, isStaff: true, onboarded: false }))).toBe("");
  });

  it("listens for cn:setup, the event every setup row dispatches (after unlocking audio in the tap)", () => {
    const host = read("src/components/setup-host.tsx");
    expect(host).toContain("window.addEventListener(SETUP_EVENT, onSetup)");
    const rows = read("src/lib/onboarding/help-rows.ts");
    expect(rows).toContain('export const SETUP_EVENT = "cn:setup";');
    const open = rows.slice(rows.indexOf("export function openSetup"), rows.indexOf("export function talkToNort"));
    expect(open.indexOf("unlockAudio();")).toBeLessThan(open.indexOf("window.dispatchEvent("));
  });

  it("is mounted once, in the app layout, with what the cap had: setup, onboarded, the role and the switches", () => {
    const layout = read("src/app/(app)/layout.tsx");
    expect(layout.match(/<SetupHost /g)).toHaveLength(1);
    expect(layout).toContain("<SetupHost initial={setup} isStaff={isStaff} onboarded={onboarded} features={doors} />");
    // Petty Cash left the menu (W1-34): the palette offers it by name to a company that has rows.
    expect(layout).toContain("<CommandBar isStaff={isStaff} features={doors} setup={setup} onboarded={onboarded} hasPettyCash={hasPettyCash} />");
    // The cap itself is gone.
    expect(layout).not.toContain("SetupButton");
    expect(read("src/components/app-shell/topbar.tsx")).not.toContain("SetupButton");
  });
});
