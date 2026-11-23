import { describe, expect, it } from "vitest";
import { appleMapsWorksHere, mapsProviderHere, navUrl } from "./maps";

/**
 * APPLE MAPS ONLY WHERE IT EXISTS (cn-v1185). A tech filed "Apple maps does not work on my phone" from
 * an Android phone: an Apple Maps link there opens a web page, never navigation, and the app both
 * asked "Apple or Google" on the first Navigate tap and drew Apple Maps as chosen in Settings. The rule
 * the link and the Settings card both read: an Android device opens Google Maps, whatever it stored;
 * every other device keeps its own choice, and asks once when it has none.
 */
const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

describe("which maps app a Navigate link opens on this device", () => {
  it("an Android phone opens Google Maps: never asked, and a stored Apple choice is not obeyed", () => {
    expect(appleMapsWorksHere(ANDROID)).toBe(false);
    for (const stored of [null, undefined, "", "apple", "google", "waze"]) expect(mapsProviderHere(stored, ANDROID)).toBe("google");
  });

  it("an Apple device, and any other that is not Android, keeps its own choice and asks once when it has none", () => {
    for (const ua of [IPHONE, MAC, WINDOWS]) {
      expect(appleMapsWorksHere(ua)).toBe(true);
      expect(mapsProviderHere(null, ua)).toBeNull();
      expect(mapsProviderHere("apple", ua)).toBe("apple");
      expect(mapsProviderHere("google", ua)).toBe("google");
      expect(mapsProviderHere("waze", ua)).toBeNull();
    }
  });

  it("a device that says nothing about itself is not guessed to be Android", () => {
    for (const ua of [null, undefined, ""]) {
      expect(appleMapsWorksHere(ua)).toBe(true);
      expect(mapsProviderHere("apple", ua)).toBe("apple");
      expect(mapsProviderHere(null, ua)).toBeNull();
    }
  });

  it("both links still open guided driving directions, never a search pin", () => {
    expect(navUrl("4 Larkspur Ln, Thistlewood", "google")).toBe("https://www.google.com/maps/dir/?api=1&destination=4%20Larkspur%20Ln%2C%20Thistlewood&travelmode=driving");
    expect(navUrl("4 Larkspur Ln, Thistlewood", "apple")).toBe("https://maps.apple.com/?daddr=4%20Larkspur%20Ln%2C%20Thistlewood&dirflg=d");
  });
});
