import { describe, it, expect } from "vitest";
import { APNS_HOSTS } from "./apns";

/**
 * The two APNs hosts are not interchangeable and getting them backwards is invisible: a token
 * minted by a debug build simply returns BadDeviceToken on the production host, which reads like
 * "the phone unregistered" rather than "wrong environment". The sender probes production, then
 * sandbox, then remembers — these pin the addresses that probe uses.
 */
describe("APNs hosts", () => {
  it("names both environments", () => {
    expect(APNS_HOSTS.production).toBe("https://api.push.apple.com");
    expect(APNS_HOSTS.sandbox).toBe("https://api.sandbox.push.apple.com");
  });

  it("never points production at the sandbox", () => {
    expect(APNS_HOSTS.production).not.toContain("sandbox");
  });
});
