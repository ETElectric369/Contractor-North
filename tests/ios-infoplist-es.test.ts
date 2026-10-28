import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE PHONE'S SPANISH PROMPTS KEEP APPLE'S NAMES (cn-v1138). ios/App/App/es.lproj/InfoPlist.strings is
 * what iOS shows a Spanish phone when North asks for Bluetooth, the camera, location or the mic. Apple's
 * product is "Tap to Pay on iPhone" in every language (its own rule, the one place Title Case yields
 * too), so the Spanish file never says "Tap to Pay en iPhone".
 */
describe("es.lproj/InfoPlist.strings", () => {
  const src = readFileSync(join(process.cwd(), "ios/App/App/es.lproj/InfoPlist.strings"), "utf8");
  it("names Tap to Pay on iPhone as Apple does, in the Bluetooth and the location prompts", () => {
    expect(src).not.toContain("Tap to Pay en iPhone");
    expect(src.match(/Tap to Pay on iPhone/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/"NSBluetoothAlwaysUsageDescription" = ".*Tap to Pay on iPhone no necesita lector/);
    expect(src).toMatch(/"NSLocationWhenInUseUsageDescription" = ".*cobrar con Tap to Pay on iPhone/);
  });
  it("carries every prompt Info.plist asks for, in the same keys", () => {
    for (const key of [
      "NSBluetoothAlwaysUsageDescription",
      "NSCameraUsageDescription",
      "NSLocationAlwaysAndWhenInUseUsageDescription",
      "NSLocationWhenInUseUsageDescription",
      "NSMicrophoneUsageDescription",
      "NSPhotoLibraryAddUsageDescription",
      "NSPhotoLibraryUsageDescription",
    ]) expect(src, key).toContain(`"${key}" = "`);
  });
});
