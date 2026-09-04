import { describe, it, expect } from "vitest";
import { isChunkLoadError, isStaleBuildError, isTransportError } from "./chunk-reload";

/** The three shapes a client boundary must tell apart: a stale chunk (reload), a stale BUILD
 *  (reload — the deploy-skew rows in the error log), and a dropped connection (retry, not a
 *  crash card, never logged as a defect). A real render bug matches none of them. */
describe("boundary error classification", () => {
  it("recognises stale-chunk loads", () => {
    expect(isChunkLoadError(new Error("Loading chunk 1236 failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Failed to fetch dynamically imported module"))).toBe(true);
  });
  it("recognises a tab from an old deploy talking to a new one", () => {
    expect(isStaleBuildError(new Error("An unexpected response was received from the server."))).toBe(true);
    expect(isStaleBuildError(new TypeError("e[o] is not a function"))).toBe(true);
    expect(isStaleBuildError(new TypeError("e[o] is not a function. (In 'e[o](a,a.exports,r)', 'e[o]' is undefined)"))).toBe(true);
    expect(isStaleBuildError(new Error("Failed to find Server Action \"abc\". This request might be from an older or newer deployment."))).toBe(true);
  });
  it("recognises a dropped connection in every browser's words", () => {
    expect(isTransportError(new TypeError("Load failed"))).toBe(true);
    expect(isTransportError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransportError(new Error("network error"))).toBe(true);
    expect(isTransportError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
  });
  it("leaves a real bug alone", () => {
    const real = new TypeError("Cannot read properties of undefined (reading 'name')");
    expect(isChunkLoadError(real)).toBe(false);
    expect(isStaleBuildError(real)).toBe(false);
    expect(isTransportError(real)).toBe(false);
  });
});
