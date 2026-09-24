import { describe, it, expect } from "vitest";
import { ownerRegister } from "@/lib/owner-draw";

describe("ownerRegister: the owner's money in the reader's own register (0286)", () => {
  const erik = { id: "e", name: "Erik Taylor" };

  it("the owner reading about himself hears 'you'", () => {
    const v = ownerRegister([erik], "e");
    expect(v).toMatchObject({
      viewerIsOwner: true,
      hoursLabel: "Your Hours",
      perHourPhrase: "per hour you worked",
      leftFor: "Owner's Draw",
      notOnPayBoard: "You are paid by owner's draw, so your hours are not on this board.",
    });
  });

  it("the office hears his first name", () => {
    const v = ownerRegister([erik, erik], "alexa");
    expect(v).toMatchObject({
      viewerIsOwner: false,
      count: 1,
      hoursLabel: "Erik's Hours",
      perHourPhrase: "per hour Erik worked",
      leftFor: "Owner's Draw",
      notOnPayBoard: "Erik is paid by owner's draw, so Erik's hours are not on this board.",
    });
  });

  it("two owners are 'the owners', whoever is reading", () => {
    const v = ownerRegister([erik, { id: "c", name: "Chris Taylor" }], "e");
    expect(v).toMatchObject({ count: 2, leftFor: "Owner's Draw", hoursLabel: "Owners' Hours" });
  });

  it("no name to say: 'the owner'", () => {
    expect(ownerRegister([{ id: "x", name: null }], "y").leftFor).toBe("Owner's Draw");
  });
});
