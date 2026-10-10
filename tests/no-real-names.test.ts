import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * NO REAL CUSTOMER, STREET, PHONE OR ACCOUNT NUMBER SHIPS IN A FIXTURE (cn-v1041).
 *
 * This repository is public. For a long time its test fixtures were Erik's actual week: his
 * customers by name, their houses by street and number, their phone numbers, and his supplier
 * account number. Anybody could read who he works for and where they live. Every one of them was
 * swapped for an invented name OF THE SAME SHAPE — same word count, same length class, same
 * near-miss spellings where a test turns on a near miss — so the assertions still mean what they
 * meant. This is the gate that keeps them out.
 *
 * THE REAL NAMES ARE NOT WRITTEN DOWN HERE. A list of them in this file would put back exactly
 * what the scrub took out, and this file is as public as the rest. So each one is kept as a salted
 * stamp of itself, and the scanner stamps the words it reads and compares. A stamp cannot be read
 * backwards, and it still recognises its own word the moment it reappears.
 *
 * WHAT A FAILURE TELLS YOU: the file, the line, and the invented name to use instead. Nothing to
 * look up and nowhere to get stuck.
 *
 * WHY IT CANNOT PASS BY SCANNING NOTHING: the scan counts the files and the words it got through
 * and fails if either is implausibly small, and two sentinel names it IS allowed to spell prove
 * the scanner can still see a one-word name and a two-word one. A broken walk, a bad filter or a
 * regex that stops matching fails here instead of going quiet.
 */

/** The stamp. Salted so it is this repo's stamp and nobody else's rainbow table. */
const SALT = "contractor-north/no-real-names/v1";
const stamp = (s: string) => createHash("sha256").update(`${SALT}\u0000${s}`).digest("hex").slice(0, 16);

/**
 * Every scrubbed name as a stamp → the invented name that replaced it. The same real name maps to
 * the same invented one everywhere, so fixtures that have to line up across files still do.
 * The last two are the sentinels: made-up words that stand in for a real name in the self-check.
 */
const SCRUBBED = new Map<string, string>([
  ["d704ed52a7d1921d", "Marla Finch"],
  ["28a6c4b67a58cf15", "Marla"],
  ["2c635478abcec1ca", "Finch"],
  ["80ae6d0fbaa8b648", "Tess Zane"],
  ["e150cdd0ef9e8db4", "Tess"],
  ["7243f635832fb47b", "Zane"],
  ["1e122d96256aad1c", "Wexley"],
  ["2641b45d7a28e232", "Wexle"],
  ["071a6dd7ae786f6d", "Norrel"],
  ["18efaca3aabb109d", "Remy Dunsmore"],
  ["812af8410f005f15", "Dunsmore"],
  ["94d4b6d176dbd5e4", "Remy"],
  ["1f40949bee4814aa", "Siskin"],
  ["fc244725e2f3bba2", "Willet"],
  ["d953800a9f6dc386", "Avocet"],
  ["8fa9d783698d005f", "Starling"],
  ["8379b625d74a115c", "Crake"],
  ["815ec56d3d0d2bef", "Clover"],
  ["c4d212274eae5f43", "Cardell"],
  ["7a0824536ab2f6b6", "Nora Gorse"],
  ["2dafe2a831675d5a", "Dale"],
  ["218f66265d03cf83", "Brandow"],
  ["587b8c3c07b90f2a", "Sparrow"],
  ["9b3c53a509033b1b", "Clearview Inspections"],
  ["d92ab2c655229982", "Clearview"],
  ["9b2de3e5177e761c", "Fernhill"],
  ["e103857405e7d5ba", "Fernhile"],
  ["9fd1d0ee82fe5836", "Thistle Wood"],
  ["e23303ed74bb11bd", "Thistlewood"],
  ["7bdb7cc8d4fc5469", "Larkspur"],
  ["71f65383ba6fee22", "Honeysuckle"],
  ["9cf904e0553d9f67", "Honysuckle"],
  ["952668eddc2fbefc", "Alder Ridge"],
  ["563898f17e06169a", "ARR"],
  ["859fe15dce1fe570", "West Garnet"],
  ["da660f7b049c060a", "W Garnet"],
  ["7dc383695a37ab44", "North Juniper"],
  ["c06efdc6dbe8594d", "Cedar Park"],
  ["0a89c2e03476c1d4", "Snowbell"],
  ["1b9e2e426ce4ad4e", "NightShade"],
  ["338da3edd5c60bfa", "Nightshade"],
  ["0808c007b54df364", "Cinder Lake"],
  ["4503635d43197f9d", "Pinyon Sage"],
  ["f09d1a8cbc20964b", "May Dell"],
  ["fc0e4ca75c6b05f4", "Sumac Lane"],
  ["c9833ae01e942e9b", "Mayfern"],
  ["173a0c8debab5f79", "Acacia"],
  ["631d6a9bb814dedb", "Bayberry"],
  ["7cea9ab57277fe12", "Sorrel"],
  ["c549ff277faf8770", "Hazelnut"],
  ["06f7b192bfe9c778", "Tupelo"],
  ["e930a76bd2eea81e", "Plover"],
  ["1ea657348bd0ef94", "Sycamore"],
  ["2b08ac91902bd001", "Mallow Springs"],
  ["701b3f9add48dd8f", "Larch Terrace"],
  ["19eeaef25d254943", "Wild Plum"],
  // Found 2026-10-09 in two comments and a fixture after the scrub (the gate had no stamp for it).
  ["025e00877c041831", "Tilda Quill"],
  ["3e39781674cdd0ab", "Tilda"],
  ["8aa5c278f72902ff", "Quill"],
  ["dd495d2a129adeae", "Rowan Vale"],
  ["84d54e1543675fce", "Rowan"],
  ["b2b8af67fcea71e6", "AC-10427"],
  ["a8c1620cacf89427", "555-0147"],
  ["0de33fd657274723", "555-0133"],
  ["f029f5ad4d4be877", "555-0145"],
  ["0af857ad4ad85858", "555-0170"],
  ["1dd32319ebbbf771", "redfinch"],
  // The supplier writes one street three more ways: truncated, split in two, and with one letter
  // wrong. Each invented stand-in keeps that exact relationship to the invented street, because
  // that relationship IS what the reconcile tests check.
  ["457ac003745bdd95", "Honey (the truncation of Honeysuckle)"],
  ["bdccb445f746cbe6", "Haneysuckle (the one-letter typo)"],
]);

/**
 * Two words this file IS allowed to spell, because nobody is called them. They stand in for a real
 * name in the self-check below, which is how we know the scanner still works without writing a real
 * name down. They are deliberately NOT in SCRUBBED, so the pass over the repo — which reads this
 * file like any other — does not trip over the self-check's own examples.
 */
const SENTINELS = new Map<string, string>([
  ["018383d49c08bcdd", "a made-up name (sentinel)"],
  ["13ecd813a41ffcdc", "a made-up name (sentinel)"],
]);
const WITH_SENTINELS = new Map([...SCRUBBED, ...SENTINELS]);

/**
 * PHRASES WHERE A SCRUBBED WORD IS NOT A PERSON.
 *
 * Some of the scrubbed words are also ordinary English, or the name of something public: a street
 * can be called the same thing as an open-source licence, an operating-system version, the region
 * this business works in, or a book that has been out of copyright for two thousand years. Banning
 * the bare word is still right — the real streets appear in fixtures with no street type after them
 * ("10429 BAYBERRY", in the invented spelling), as job ids, and as surnames, so a rule that only
 * fired on pairs would let every one of them back in, which is why the bare entries stay and this
 * list exists instead. It must not fire on the public thing of the same name. Each entry below
 * is a whole PHRASE that is known not to be about a person. A hit whose surrounding 2 or 3 words
 * match one of these is not a hit.
 *
 * The phrases are stamped for the same reason the names are: writing "<word> 2.0" here would say
 * out loud which street was scrubbed. TO ADD ONE, print the stamp of the normalised phrase — the
 * words lowercased with every run of non-letters as one space:
 *
 *   node -e 'const c=require("crypto");const s="contractor-north/no-real-names/v1";
 *            console.log(c.createHash("sha256").update(s+"\0"+process.argv[1]).digest("hex").slice(0,16))' "the phrase"
 */
const INNOCENT = new Map<string, string>([
  ["5392a795f3a90bce", "a public-domain book whose title opens with a scrubbed surname (the planner's quote of the day)"],
  ["00e0a9d9ff325a00", "an open-source licence whose name is also a scrubbed street"],
  ["17bdc597f6f2538e", "the same licence, written with its version number"],
  ["2432e563da250445", "the same licence, spelled out"],
  ["8cc766123fdad34e", "the same licence's foundation"],
  ["80994dffc208d083", "an operating-system version named after a scrubbed street"],
  ["e6e59a08c2c74705", "the same version, with its vendor prefix"],
  ["18f1c1cd338bb84a", "the region this business works in, which opens with a scrubbed street"],
]);

/**
 * The first word of every two-word stamp. Only after one of these is it worth pairing the next
 * word, which is what keeps a three-million-word scan down to a couple of seconds.
 */
const PAIR_STARTS = new Set<string>([
  "2b6ad90c4c96e572",
  "e90ae185b1d89c8d",
  "6287237d8c61272a",
  "f81c48ad74e006cd",
  "04c3b815b40f24c5",
  "94d4b6d176dbd5e4",
  "28a6c4b67a58cf15",
  "ad25e7c739b6e74d",
  "49b45ecc525e4ef1",
  "88004bd830a47bc3",
  "9b7913675230fe0c",
  "929a62e58650eff2",
  "9ca52be9103f8a7c",
  "d92ab2c655229982",
  "0920df29e852a148",
  "c401a68a0e915ad6",
  "e150cdd0ef9e8db4",
  "325030c894775a31",
  "7d3e64a23fd7aedd",
  "32ce6b68045dbefe",
  "33ae3723b6683f3f",
  "40b649abbb26b876",
  "435bb1648b1161d2",
  "84d54e1543675fce",
  "3e39781674cdd0ab",
]);

/**
 * The words of a line, the way a name is written in code as well as in prose: camelCase and
 * PascalCase come apart first ("honeysuckleRows" is two words, "NightShade" is two words), then
 * everything that is not a letter or a digit is a gap, so "thistle-wood", "Thistle Wood",
 * "THISTLE_WOOD" and "555-0147" all read the same. A name hiding in an identifier is still a name:
 * an UPPER_SNAKE export is exactly where the first pass of this scrub missed one.
 */
const normalise = (text: string): string =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    // Newlines survive, so a whole file can be normalised in one pass and still be split into the
    // lines a failure has to name. Nothing here adds or removes a newline.
    .replace(/[^a-z0-9\n]+/g, " ");

const wordsOf = (text: string): string[] => normalise(text).split(/[\n ]+/).filter(Boolean);

const seen = new Map<string, string>();
const stampOf = (w: string): string => {
  let h = seen.get(w);
  if (h === undefined) {
    h = stamp(w);
    seen.set(w, h);
  }
  return h;
};

/**
 * Why the word at `i` is not about a person, if one of the 2- and 3-word phrases it sits inside is
 * an allowlisted public thing. Two and three words is the whole reach: every phrase in INNOCENT is
 * that long, and a longer one would start matching sentences rather than names.
 */
function innocentAround(words: string[], i: number, innocent: Map<string, string> = INNOCENT): string | undefined {
  for (let n = 2; n <= 3; n++) {
    for (let s = Math.max(0, i - n + 1); s <= i && s + n <= words.length; s++) {
      const why = innocent.get(stampOf(words.slice(s, s + n).join(" ")));
      if (why) return why;
    }
  }
  return undefined;
}

/** The invented name for every scrubbed name these words still contain. */
function scrubbedNamesInWords(words: string[], table: Map<string, string>, innocent: Map<string, string> = INNOCENT): string[] {
  const found: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const h = stampOf(words[i]);
    const one = table.get(h);
    const two = PAIR_STARTS.has(h) && i + 1 < words.length ? table.get(stampOf(`${words[i]} ${words[i + 1]}`)) : undefined;
    if ((one || two) && innocentAround(words, i, innocent)) continue;
    if (one) found.push(one);
    if (two) found.push(two);
  }
  return found;
}

/** The same, from text, for the self-check. */
const scrubbedNamesIn = (text: string, table: Map<string, string> = SCRUBBED, innocent: Map<string, string> = INNOCENT) =>
  scrubbedNamesInWords(wordsOf(text), table, innocent);

/**
 * A two-word name wrapped over a line break is still the name, and four of them were: a quote in a
 * doc comment and three long explanations had the street's first word at the end of one line and
 * the rest at the start of the next, so a scan that stops at the newline walked straight past them.
 * Each line is therefore also paired with the last word of the line before it.
 */
function acrossTheBreak(
  lastWordBefore: string | undefined,
  wordsHere: string[],
  table: Map<string, string>,
  innocent: Map<string, string> = INNOCENT,
): string | undefined {
  const firstWordHere = wordsHere[0];
  if (!lastWordBefore || !firstWordHere) return undefined;
  if (!PAIR_STARTS.has(stampOf(lastWordBefore))) return undefined;
  const name = table.get(stampOf(`${lastWordBefore} ${firstWordHere}`));
  if (!name) return undefined;
  // A public phrase is still public when a line break falls inside it.
  if (innocentAround([lastWordBefore, ...wordsHere], 0, innocent)) return undefined;
  return name;
}

/**
 * WHAT TO DO ABOUT IT, both ways, because the advice used to only go one way. A word can match here
 * and still be innocent — some of the scrubbed streets are ordinary English — so a message that
 * only said "write X instead" sent a developer off to make the code wrong, and could not say why it
 * fired because the real word is a stamp. Both doors are named, and neither is a dead end.
 */
const advice = (instead: string) =>
  `if it is a person, a customer or their street, write "${instead}" instead; if it is an ordinary ` +
  `word (a licence, an OS version, a place, a book), add the phrase to INNOCENT in ` +
  `tests/no-real-names.test.ts — the recipe is in the comment above it`;

/** 555-01xx is the reserved example range. Anything else shaped like a phone number is somebody's. */
const PHONE_SHAPED = /(?<![0-9])\(?[2-9][0-9]{2}\)?[ .)-]{1,2}[0-9]{3}[ .-][0-9]{4}(?![0-9])/g;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * EVERY DIRECTORY THE PUBLIC CAN READ, not just the one the app is built from. The first pass of
 * this gate walked src/ and tests/ only, and a .test.ts parked under docs/archive/ — exactly the
 * kind of file this gate was built for — kept a beta tester's full name for that reason, green
 * forever because nothing walked it. A missing directory fails the walk rather than being skipped.
 */
const WALKED = ["src", "tests", "docs", "scripts", ".github", "public"];

function shippedFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) shippedFiles(p, out);
    else if (/\.(ts|tsx|css|svg)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the scanner can see", () => {
  it("finds a one-word name and a two-word name", () => {
    const find = (s: string) => scrubbedNamesIn(s, WITH_SENTINELS);
    expect(find("He wired 12 Zzsentinelname Rd")).toEqual(["a made-up name (sentinel)"]);
    expect(find("the job on Zzsentinel Hollow")).toEqual(["a made-up name (sentinel)"]);
    // A name hiding in an identifier is still a name, in any of the three ways code writes one.
    expect(find("const zzsentinelnameRows = []")).toEqual(["a made-up name (sentinel)"]);
    expect(find("export const ZZSENTINEL_HOLLOW = ``")).toEqual(["a made-up name (sentinel)"]);
    expect(find("import { ZzsentinelHollow } from './x'")).toEqual(["a made-up name (sentinel)"]);
    // And it is the self-check that is allowed to spell them, not the repo.
    expect(scrubbedNamesIn("He wired 12 Zzsentinelname Rd")).toEqual([]);
  });

  it("sees a two-word name wrapped over a line break", () => {
    expect(acrossTheBreak("zzsentinel", ["hollow"], WITH_SENTINELS)).toBe("a made-up name (sentinel)");
    expect(acrossTheBreak("zzsentinel", ["hollow"], SCRUBBED)).toBeUndefined();
    expect(acrossTheBreak("alder", ["ridge"], WITH_SENTINELS)).toBeUndefined();
    expect(acrossTheBreak(undefined, ["hollow"], WITH_SENTINELS)).toBeUndefined();
    expect(acrossTheBreak("zzsentinel", [], WITH_SENTINELS)).toBeUndefined();
  });

  /**
   * The allowlist, proved on a made-up public thing for the same reason the names are stamps: a test
   * that spelled the real licence or the real book title would say out loud which street was
   * scrubbed, and that is the one thing this file must not do.
   */
  describe("a scrubbed word inside an allowlisted phrase", () => {
    const INNOCENT_SENTINEL = new Map([[stamp("zzsentinelname press"), "a made-up public thing (sentinel)"]]);
    const find = (s: string) => scrubbedNamesIn(s, WITH_SENTINELS, INNOCENT_SENTINEL);

    it("is not a hit, because the phrase is not about a person", () => {
      expect(find("the Zzsentinelname Press edition, 1934")).toEqual([]);
      expect(find("published by Zzsentinelname Press")).toEqual([]);
    });

    it("is still a hit everywhere else, so the allowlist cannot be a hole", () => {
      expect(find("He wired 12 Zzsentinelname Rd")).toEqual(["a made-up name (sentinel)"]);
      // The word right next to a near-miss of the phrase is not covered either.
      expect(find("Zzsentinelname pressed the breaker in")).toEqual(["a made-up name (sentinel)"]);
    });

    it("reaches three words and no further", () => {
      // Far enough away that no 2- or 3-word window holds both: the name is reported again.
      expect(find("Zzsentinelname lives four words from the Press")).toEqual(["a made-up name (sentinel)"]);
    });

    it("still covers the phrase when a line break falls inside it", () => {
      expect(acrossTheBreak("zzsentinel", ["hollow"], WITH_SENTINELS, new Map([[stamp("zzsentinel hollow press"), "x"]]))).toBe(
        "a made-up name (sentinel)",
      );
      expect(acrossTheBreak("zzsentinel", ["hollow", "press"], WITH_SENTINELS, new Map([[stamp("zzsentinel hollow press"), "x"]]))).toBeUndefined();
    });

    it("is spelled as a stamp, never as the phrase itself", () => {
      expect(INNOCENT.size).toBeGreaterThan(0);
      for (const [key, why] of INNOCENT) {
        expect(key, `${key} is not a stamp`).toMatch(/^[0-9a-f]{16}$/);
        expect(why.length, `${key} does not say what it is`).toBeGreaterThan(10);
      }
    });
  });

  /**
   * THE GATE MUST NOT REJECT THE CORRECT TEXT. One scrubbed surname is also the first word of a
   * public-domain book, and the quote of the day on /planner credits it. The first pass of the
   * scrub mangled that attribution into a fake customer's name wrapped in two NUL bytes, and then
   * the gate refused the correct spelling — so the defect could not be fixed without this
   * allowlist. If the allowlist entry goes, this fails rather than the quote going wrong again.
   */
  it("passes the quote of the day on the planner, as it is actually written", () => {
    const planner = readFileSync(path.join(ROOT, "src/app/(app)/planner/page.tsx"), "utf8");
    const quotes = planner.split("\n").filter((l) => /^\s*"[^"]+",\s*$/.test(l));
    expect(quotes.length, "the QUOTES array did not read").toBeGreaterThan(20);
    for (const line of quotes) {
      expect(scrubbedNamesIn(line), `a quote of the day trips the gate: ${line.trim()}`).toEqual([]);
    }
  });

  it("leaves the invented names alone, which is the whole point of swapping them in", () => {
    const find = (s: string) => scrubbedNamesIn(s, WITH_SENTINELS);
    expect(find("13897 Honeysuckle Ct · Marla Finch · 41 Larkspur Pl · 530-555-0147")).toEqual([]);
    expect(find("235 Thistlewood Court, account AC-10427, Tess Zane")).toEqual([]);
    expect(find("13631 NightShade Blvd, 3245 West Garnet Boulevard, Alder Ridge Rentals")).toEqual([]);
  });
});

describe("no shipped file names a real customer, street, phone or account", () => {
  // One pass over the whole of src/ and tests/, both checks on the same read. Three million words,
  // so it is given room: the point is that it reads everything, not that it reads fast.
  it(
    "every .ts, .tsx, .css and .svg the public can read is clean",
    () => {
      const files = WALKED.flatMap((d) => {
        const dir = path.join(ROOT, d);
        expect(statSync(dir).isDirectory(), `${d}/ is not there to walk`).toBe(true);
        return shippedFiles(dir);
      });
      let wordsRead = 0;
      const names: string[] = [];
      const phones: string[] = [];
      for (const f of files) {
        const rel = path.relative(ROOT, f);
        const raw = readFileSync(f, "utf8");
        const lines = raw.split("\n");
        const normalisedLines = normalise(raw).split("\n");
        expect(normalisedLines.length, `${rel}: normalising moved the line breaks`).toBe(lines.length);
        let lastWordBefore: string | undefined;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const words = normalisedLines[i].split(" ").filter(Boolean);
          wordsRead += words.length;
          const wrapped = acrossTheBreak(lastWordBefore, words, SCRUBBED);
          if (wrapped) names.push(`${rel}:${i} names someone real over the line break — ${advice(wrapped)}`);
          if (words.length) lastWordBefore = words[words.length - 1];
          for (const instead of new Set(scrubbedNamesInWords(words, SCRUBBED))) {
            names.push(`${rel}:${i + 1} names someone real — ${advice(instead)}`);
          }
          for (const m of line.match(PHONE_SHAPED) ?? []) {
            if (!m.includes("555")) phones.push(`${rel}:${i + 1} ${m} — use a 555-01xx number`);
          }
        }
      }

      // It scanned the repo, not an empty list: a walk that finds nothing fails here instead of
      // going quiet, and so does a read that comes back blank.
      expect(files.length, "the walk found almost no files").toBeGreaterThan(1500);
      expect(wordsRead, "the files read almost empty").toBeGreaterThan(2_500_000);

      expect(names, `${names.length} real name(s) are back:\n${names.join("\n")}`).toEqual([]);
      expect(phones, `${phones.length} phone number(s) are somebody's:\n${phones.join("\n")}`).toEqual([]);
    },
    60_000,
  );

  /**
   * AND NO HOUSE NUMBER WAS LEFT BEHIND BY ITS STREET.
   *
   * Swapping the street word is only half an address. Three doc comments wrapped an address over a
   * line break with the number at the end of one line and the street at the start of the next, the
   * sweep replaced the street and walked past the number, and the real house number stayed in the
   * repo in front of an invented street. The word scan above cannot see it: a number is not a name.
   *
   * The fixtures are the authority. Every house number a TEST writes in front of an invented street
   * is by definition invented, near misses included — a test turns on "a different house number is
   * never the street", so one street legitimately has several. A number in front of that street
   * ANYWHERE ELSE that no fixture uses is a real one the sweep stranded.
   */
  it("every house number written in front of an invented street is one the fixtures use", () => {
    // The invented names, longest first so "Clearview Inspections" wins over "Clearview". The
    // parenthetical entries explain themselves after the name, so only the name itself is taken.
    const invented = [...SCRUBBED.values()]
      .map((v) => v.split(" (")[0])
      .filter((v) => /^[A-Za-z][A-Za-z ]*$/.test(v))
      .sort((a, b) => b.length - a.length);
    // A number is a HOUSE number only when nothing runs into it: "J-010 Pinyon Sage" is a job
    // number followed by a job's name, which is how Erik asks to be shown a job, not an address.
    const re = new RegExp(`(?<![A-Za-z0-9-])(\\d{1,6})\\s+(${invented.map((v) => v.replace(/ /g, "\\s+")).join("|")})\\b`, "gi");

    const fixtureNumbers = new Map<string, Set<string>>();
    const elsewhere: { street: string; num: string; where: string }[] = [];
    const files = WALKED.flatMap((d) => shippedFiles(path.join(ROOT, d))).filter((f) => /\.tsx?$/.test(f));

    for (const f of files) {
      const rel = path.relative(ROOT, f);
      const isFixture = /\.test\.tsx?$/.test(rel);
      // One flat string per file, with each line's comment leader dropped, so an address split over
      // a line break reads as the one address it is. `starts` maps an offset back to its line.
      const lines = readFileSync(f, "utf8").split("\n");
      const starts: number[] = [];
      let flat = "";
      for (const line of lines) {
        starts.push(flat.length);
        flat += `${line.replace(/^\s*(\*\/|\*|\/\/|\/\*\*?)\s?/, " ")} `;
      }
      for (const m of flat.matchAll(re)) {
        const street = m[2].replace(/\s+/g, " ").toLowerCase();
        if (isFixture) {
          if (!fixtureNumbers.has(street)) fixtureNumbers.set(street, new Set());
          fixtureNumbers.get(street)!.add(m[1]);
        } else {
          let lo = 0;
          while (lo + 1 < starts.length && starts[lo + 1] <= m.index) lo++;
          elsewhere.push({ street, num: m[1], where: `${rel}:${lo + 1}` });
        }
      }
    }

    // It read the fixtures, not an empty list: a regex that stops matching fails here.
    expect(fixtureNumbers.size, "no invented street was found in any fixture").toBeGreaterThan(10);

    const stranded = elsewhere
      .filter((h) => !fixtureNumbers.get(h.street)?.has(h.num))
      .map(
        (h) =>
          `${h.where} says "${h.num} ${h.street}" — no fixture uses that number with that street, so it is a real ` +
          `one the scrub left behind; write ${[...(fixtureNumbers.get(h.street) ?? [])].sort().join(" or ") || "the fixtures' number"} instead`,
      );
    expect(stranded, `${stranded.length} real house number(s) are still here:\n${stranded.join("\n")}`).toEqual([]);
  });
});
