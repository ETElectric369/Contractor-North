import { describe, it, expect } from "vitest";
import { shellFromUserAgent } from "./native-shell";

describe("shellFromUserAgent — the one native detector", () => {
  it("recognises the shell's user-agent mark on both platforms", () => {
    expect(shellFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 CNShell/1 (iOS)")).toEqual({ native: true, platform: "ios", version: 1 });
    expect(shellFromUserAgent("Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile CNShell/2 (Android)").platform).toBe("android");
  });
  it("is false for Safari, the installed PWA, and nothing at all", () => {
    expect(shellFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1").native).toBe(false);
    expect(shellFromUserAgent(null).native).toBe(false);
  });
});
