import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { TRADE_ORDER } from "@/lib/trade-package";
import { ELECTRICAL_NORT, NEUTRAL_NORT, TRADE_NORT, tradeNort } from "./trade-nort";

/**
 * NORT'S TRADE-SHAPED WORDS, one row per trade, SERVER-ONLY (cn-v1135). The electrician's words are
 * today's, byte for byte (cn-v339, cn-v1128); the nine other trades share the neutral set, which names
 * no trade's parts. And the module never reaches a browser: it carries `import "server-only"`, and no
 * "use client" file imports it, or lib/nort/trade-prompt, which reads it.
 */
const root = process.cwd();
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(n) && !/\.(test|db-suite)\.tsx?$/.test(n) ? [p] : [];
  });

describe("the electrician's words are today's, byte for byte, and every other trade speaks the neutral set", () => {
  it("electrical: the field-tested sentences, word for word", () => {
    const e = ELECTRICAL_NORT;
    expect(e.engineering).toBe(
      "- ENGINEERING: calculate the real numbers per NEC — CALL the calc tools (calc_wire_size, calc_voltage_drop, calc_conduit_fill, calc_box_fill) for exact answers, don't eyeball sizes/quantities, and show what they returned so it's verifiable.",
    );
    expect(e.estimatorQuantities).toBe(
      "QUANTITIES: calculate per the governing code for this trade — don't eyeball. For anything the CALCULATOR TOOLS cover (wire size, voltage drop, conduit fill, box fill) CALL THE TOOL instead of working the tables from memory; they return the exact NEC answer plus the code rule behind it. Reasoning a table in your head is where wrong numbers come from. ",
    );
    expect(e.clarifying).toBe("residential vs commercial, panel size, etc.");
    expect(e.webSpecs).toBe("pull real specs like wire/breaker sizes");
    expect(e.cardFacts).toBe("gate/lockbox code, balance due, hours today, amp size, next appointment");
    expect(e.assumptions).toBe(
      "the ones that change everything: fuel type (propane / natural gas), panel or service size, overhead vs underground, permitted or not. Ask 'Propane or natural gas?' up front",
    );
    expect(e.siteChatPackage).toBe("a like-for-like panel swap");
    expect(e.siteChatMoving).toBe("Copper, breakers, EV chargers and fixtures move month to month");
    expect(e.siteChatSmallStuff).toBe("wire, nuts, staples, screws, straps");
    // The photo line drops ", deck size/shape" — a Tahoe leftover on an electrician's prompt.
    expect(e.siteChatPhoto).toBe("panel brand & amperage, wiring/condition, access");
    expect(TRADE_NORT.electrical).toBe(ELECTRICAL_NORT);
  });

  it("the neutral set names no trade's parts, and the nine other trades share it (the deck row's photo line aside)", () => {
    for (const w of Object.values(NEUTRAL_NORT)) expect(w).not.toMatch(/NEC|wire|breaker|panel|conduit|amp\b|voltage|propane/i);
    expect(NEUTRAL_NORT.siteChatSmallStuff).toBe("fasteners, clips, sealant and the small hardware");
    for (const k of TRADE_ORDER) {
      if (k === "electrical") continue;
      const { siteChatPhoto: _photo, ...rest } = TRADE_NORT[k];
      const { siteChatPhoto: _neutralPhoto, ...neutral } = NEUTRAL_NORT;
      expect(rest, k).toEqual(neutral);
    }
    expect(TRADE_NORT.deck.siteChatPhoto).toBe("deck size/shape, its condition, and the access");
    expect(TRADE_NORT.plumbing.siteChatPhoto).toBe(NEUTRAL_NORT.siteChatPhoto);
  });

  it("one row per TRADE_ORDER key; an unknown or blank key reads the neutral set", () => {
    expect(Object.keys(TRADE_NORT).sort()).toEqual([...TRADE_ORDER].sort());
    expect(tradeNort("")).toBe(NEUTRAL_NORT);
    expect(tradeNort("other")).toBe(NEUTRAL_NORT);
    expect(tradeNort(undefined)).toBe(NEUTRAL_NORT);
    expect(tradeNort("electrical")).toBe(ELECTRICAL_NORT);
    expect(tradeNort("deck")).toBe(TRADE_NORT.deck);
  });
});

describe("the words never reach a browser", () => {
  it("the module is server-only, on its first line", () => {
    expect(readFileSync(join(root, "src/lib/trade-nort.ts"), "utf8").split("\n")[0]).toBe('import "server-only";');
  });

  it('no "use client" file under src imports lib/trade-nort or lib/nort/trade-prompt', () => {
    const hits = walk(join(root, "src"))
      .map((f) => relative(root, f))
      .filter((f) => {
        const text = readFileSync(join(root, f), "utf8");
        return /^\s*["']use client["']/m.test(text) && /["']@\/lib\/(trade-nort|nort\/trade-prompt)["']/.test(text);
      });
    expect(hits).toEqual([]);
  });

  it("the readers import it from lib/trade-nort, not the registry", () => {
    for (const f of ["src/lib/nort/trade-prompt.ts", "src/app/api/site-chat/route.ts"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).toMatch(/import \{[^}]*\btradeNort\b[^}]*\} from "@\/lib\/trade-nort"/);
    }
    expect(readFileSync(join(root, "src/lib/trade-package.ts"), "utf8")).not.toContain("tradeNort");
  });
});
