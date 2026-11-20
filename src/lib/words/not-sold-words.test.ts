import { describe, it, expect } from "vitest";
import { CATALOGS, translator } from "@/lib/i18n";
import { titleCaseIn } from "../../../tests/title-case-words";

/**
 * NOT SOLD, NEVER LOST (cn-v1170). Erik, 2026-11-19: "Not Sold" replaces "Lost" everywhere, for the
 * ending of a lead, a visit and a deal. This reads every catalog except the leads' (ld_, ld_srv_) and
 * Needs You's (ny_), which their own builders pin, and holds the "lost" left in them to a named list:
 * each one is an unrelated lost (nothing lost on a dropped connection, a scan that did not arrive),
 * never an ending. A new "lost" anywhere fails here until it is judged.
 */
const NOT_MINE = (prefix: string) => prefix.startsWith("ld_") || prefix === "ny_";

/** The deliberate "lost" left, by key and why. */
const UNRELATED_LOST: Record<string, string> = {
  cs_overlapCantClose: "nothing was lost: the shift is still running",
  mt_replacedBody: "the items are kept so nothing is lost",
  nt_errBody: "nothing was lost in a dropped conversation",
  sh_checkSignal: "nothing was lost on a bad signal",
  vi_answeredThenEdited: "nothing was lost when the questions were edited",
  vi_modelLost: "a 3D model that did not arrive whole",
};

const hits = (lang: "en" | "es", re: RegExp) => {
  const out: string[] = [];
  for (const c of CATALOGS) {
    if (NOT_MINE(c.prefix)) continue;
    for (const [k, v] of Object.entries(c[lang])) if (re.test(String(v))) out.push(k);
  }
  return out.sort();
};

describe("Not Sold replaces Lost in every catalog WORD owns", () => {
  it("English: no value says lost except the named unrelated ones", () => {
    expect(hits("en", /\blost\b/i)).toEqual(Object.keys(UNRELATED_LOST).sort());
  });

  it("Spanish: no value says perdido / perdida for an ending", () => {
    // "se perdió" (vi_modelLost) is a verb, not the ending's word, and does not match.
    expect(hits("es", /\bperdid[oa]s?\b/i)).toEqual([]);
  });

  it("the ending's words, both languages, the clickables in Title Case", () => {
    const en = translator("en");
    const es = translator("es");
    const doors: [string, string, string][] = [
      ["vp_btn_lost", "Not Sold", "No Vendida"],
      ["ip_btn_lost", "Not Sold", "No Vendida"],
      // cn-v1171: the Inspections tile went; a filed inspection's ending in the fold says it.
      ["ip_endedNotSold", "Not Sold", "No Vendida"],
    ];
    for (const [k, e, s] of doors) {
      expect(en(k), k).toBe(e);
      expect(es(k), k).toBe(s);
      expect(titleCaseIn(en(k), "en"), k).toBe(true);
      expect(titleCaseIn(es(k), "es"), k).toBe(true);
    }
    expect([en("vp_lost"), es("vp_lost")]).toEqual(["Not Sold", "No Vendida"]);
    // Inside a sentence: English keeps the capitals, Spanish is lowercase.
    expect([en("vp_markedLost"), es("vp_markedLost")]).toEqual(["Marked Not Sold.", "Marcada como no vendida."]);
    expect(en("vp_markedLostLeadToo")).toBe("Marked Not Sold. The lead is Not Sold too.");
    expect(es("vp_markedLostLeadToo")).toBe("Marcada como no vendida. El prospecto también quedó como no vendido.");
    // The lowercase status family.
    expect([en("ag_srv_leadStatus_lost"), es("ag_srv_leadStatus_lost")]).toEqual(["not sold", "no vendido"]);
    // The estimate's sentence names the visit page's own door.
    for (const t of [en, es]) expect(t("qs_stampNotLinked")).toContain(t("vp_lost"));
  });
});
