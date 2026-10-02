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

/** The invented name for every scrubbed name these words still contain. */
function scrubbedNamesInWords(words: string[], table: Map<string, string>): string[] {
  const found: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const h = stampOf(words[i]);
    const one = table.get(h);
    if (one) found.push(one);
    if (PAIR_STARTS.has(h) && i + 1 < words.length) {
      const two = table.get(stampOf(`${words[i]} ${words[i + 1]}`));
      if (two) found.push(two);
    }
  }
  return found;
}

/** The same, from text, for the self-check. */
const scrubbedNamesIn = (text: string, table: Map<string, string> = SCRUBBED) => scrubbedNamesInWords(wordsOf(text), table);

/**
 * A two-word name wrapped over a line break is still the name, and four of them were: a quote in a
 * doc comment and three long explanations had the street's first word at the end of one line and
 * the rest at the start of the next, so a scan that stops at the newline walked straight past them.
 * Each line is therefore also paired with the last word of the line before it.
 */
function acrossTheBreak(lastWordBefore: string | undefined, firstWordHere: string | undefined, table: Map<string, string>): string | undefined {
  if (!lastWordBefore || !firstWordHere) return undefined;
  if (!PAIR_STARTS.has(stampOf(lastWordBefore))) return undefined;
  return table.get(stampOf(`${lastWordBefore} ${firstWordHere}`));
}

/** 555-01xx is the reserved example range. Anything else shaped like a phone number is somebody's. */
const PHONE_SHAPED = /(?<![0-9])\(?[2-9][0-9]{2}\)?[ .)-]{1,2}[0-9]{3}[ .-][0-9]{4}(?![0-9])/g;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
    expect(acrossTheBreak("zzsentinel", "hollow", WITH_SENTINELS)).toBe("a made-up name (sentinel)");
    expect(acrossTheBreak("zzsentinel", "hollow", SCRUBBED)).toBeUndefined();
    expect(acrossTheBreak("alder", "ridge", WITH_SENTINELS)).toBeUndefined();
    expect(acrossTheBreak(undefined, "hollow", WITH_SENTINELS)).toBeUndefined();
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
    "every .ts, .tsx, .css and .svg under src/ and tests/ is clean",
    () => {
      const files = [...shippedFiles(path.join(ROOT, "src")), ...shippedFiles(path.join(ROOT, "tests"))];
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
          const wrapped = acrossTheBreak(lastWordBefore, words[0], SCRUBBED);
          if (wrapped) names.push(`${rel}:${i} still names someone real over the line break — write "${wrapped}" instead`);
          if (words.length) lastWordBefore = words[words.length - 1];
          for (const instead of new Set(scrubbedNamesInWords(words, SCRUBBED))) {
            names.push(`${rel}:${i + 1} still names someone real — write "${instead}" instead`);
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
});
