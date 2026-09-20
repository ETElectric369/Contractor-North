/**
 * WHO A SUPPLIER IS, WHEN ALL YOU HAVE IS WHAT THE SCANNER TYPED (Erik, 2026-09-18).
 *
 * His Bills screen opens on Unpaid at $13,040.07 across 21 bills, and $12,572.20 of that is ONE
 * CED account wearing five different names:
 *
 *   "Consolidated Electrical Distributors, Inc. (CED)"   4 bills   $5,570.56
 *   "Consolidated Electrical Dist."                      8 bills   $4,366.24
 *   "Consolidated Electrical Distributors, Inc."         6 bills   $2,179.38
 *   "Consolidated Electrical Distributors"               1 bill      $456.02
 *   "CED"                                                2 bills        $0
 *
 * `bills.supplier` is free text the receipt reader writes afresh on every scan, so a balance keyed
 * on the text would have shown him four CED balances on day one. Migration 0270 gave the money a
 * home that is not a spelling (supplier_accounts + supplier_aliases). This file is the other half:
 * working out WHICH spellings are probably the same account.
 *
 * ── IT SUGGESTS. IT NEVER MERGES. ────────────────────────────────────────────────────────────
 *
 * Nothing in here decides anything. Every function returns a suggestion with the reason in plain
 * words, for Erik to accept or ignore, and accepting one is a supplier_aliases row he creates by
 * pressing something. That is not caution for its own sake, it is the only defensible position:
 *
 *   · The sixth CED-ish name, "Contractors Electrical Distributors" ($467.87), has the same
 *     initials, the same two trade words and a different first word. It is a REAL different
 *     storefront near Sunnyvale that he charged to his Truckee account number ("its the local
 *     distributor near sunnyvale for the job so i used my truckee account number, thats how they
 *     roll"). The money rolls up to one account; the ticket stays with its branch, because the
 *     price book learns from these receipts and a Sunnyvale price is not a Truckee price. NO
 *     amount of string cleverness gets that out of the string. The answer came from him.
 *
 *   · "Ace Mountain Hardware" and "Ace - Mountain Hardware" are one store. "Mountain Hardware and
 *     Sports" is a DIFFERENT Truckee store that happens to share two words with it. A matcher that
 *     swept those together would merge two real vendors' money, which is why that pair is the
 *     first test in supplier-identity.test.ts and why a shared trade word ("hardware", "supply",
 *     "electric", "distributors") can never by itself hold a suggestion up.
 *
 * So the grammar here is: normalise, gather EVIDENCE, grade it. Strong and likely evidence
 * proposes a group; anything thinner comes back as a candidate that sits beside the group saying
 * what it noticed and why it will not decide.
 */

/** Words that say nothing about WHICH company this is: legal forms, articles, connectors.
 *  "&" folds away to nothing and "and" is dropped, so "A & B" and "A and B" read alike. */
const STOP = new Set([
  "the", "a", "an", "and", "of", "dba",
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited",
  "corp", "corporation", "co", "company", "plc",
]);

/**
 * TRADE words: real parts of the name, but shared by every business of that kind in town. They
 * stay in the name (they are half of what makes "OSH" the initials of "Outdoor Supply Hardware")
 * and they are barred from being the ONLY thing two names have in common.
 *
 * This set is why "Ace Mountain Hardware" and "Mountain Hardware and Sports" produce nothing at
 * all: strip the trade word and what is left is "ace, mountain" against "mountain, sports", which
 * is two stores.
 */
const GENERIC = new Set([
  "hardware", "supply", "distributors", "electric",
  "lumber", "plumbing", "building", "materials", "wholesale", "wholesalers",
  "warehouse", "tools", "industrial", "store", "stores", "center", "outlet",
  "services", "rental", "rentals",
]);

/** Spellings the scanner and the counter staff use interchangeably. "Dist." IS "Distributors" and
 *  nothing is lost by saying so; this is the one place a shortening may be expanded, because the
 *  expansion is a fact about the abbreviation, not a guess about the company. */
const ABBREV: Record<string, string> = {
  dist: "distributors",
  distr: "distributors",
  distrib: "distributors",
  distributing: "distributors",
  distributor: "distributors",
  hdw: "hardware",
  hdwe: "hardware",
  hrdwr: "hardware",
  mtn: "mountain",
  mtns: "mountain",
  electrical: "electric",
  elec: "electric",
  supplies: "supply",
  sply: "supply",
  bros: "brothers",
  svc: "services",
  svcs: "services",
  service: "services",
  ctr: "center",
  cntr: "center",
  centre: "center",
};

/** Lowercase, drop possessives ("Swigard's" is "Swigards"), turn every other mark into a space.
 *  Punctuation is the noise this whole file exists to see through. */
function fold(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The meaningful words of a name, in order: folded, expanded, legal forms dropped. */
function tokensOf(raw: unknown): string[] {
  const folded = fold(raw);
  if (!folded) return [];
  return folded
    .split(" ")
    .map((t) => ABBREV[t] ?? t)
    .filter((t) => t.length > 0 && !STOP.has(t));
}

/** A bracketed piece of a name: "(CED)", "(OSH - Cupertino)". Kept whole, because it is often the
 *  person writing down the very equivalence we are otherwise trying to guess. */
export type SupplierAside = { text: string; key: string };

export type SupplierNameShape = {
  /** Exactly as it was scanned. This is what goes in supplier_aliases.alias. */
  raw: string;
  /** The meaningful words, brackets removed. */
  core: string[];
  /** core joined by spaces: the normalised name two spellings are compared on. */
  key: string;
  /** core minus the shared trade words: what actually names the company. */
  distinctive: string[];
  /** First letters of core: "consolidated electric distributors" gives "ced". */
  initials: string;
  /** Anything that was in brackets, normalised the same way. */
  asides: SupplierAside[];
  /** A single short all-letters word, i.e. the name might BE an initialism ("CED", "OSH"). */
  isInitialism: boolean;
};

/** Read one scanned supplier string into the shape everything else here compares. Pure. */
export function readSupplierName(raw: string | null | undefined): SupplierNameShape {
  const text = String(raw ?? "");
  const asides: SupplierAside[] = [];
  for (const m of text.matchAll(/[([]([^)\]]+)[)\]]/g)) {
    const inner = String(m[1] ?? "").trim();
    const key = tokensOf(inner).join(" ");
    if (key) asides.push({ text: inner, key });
  }
  const core = tokensOf(text.replace(/[([][^)\]]*[)\]]/g, " "));
  return {
    raw: text,
    core,
    key: core.join(" "),
    distinctive: core.filter((t) => !GENERIC.has(t)),
    initials: core.map((t) => t[0]).join(""),
    asides,
    isInitialism: core.length === 1 && /^[a-z]{2,5}$/.test(core[0] ?? ""),
  };
}

/** The normalised name on its own, for callers that just want a comparison key. */
export function normalizeSupplierName(raw: string | null | undefined): string {
  return readSupplierName(raw).key;
}

/** How much a suggestion is worth. "strong" and "likely" propose a group; "possible" never does,
 *  it only asks. All three still need a person to press something. */
export type SupplierConfidence = "strong" | "likely" | "possible";

/** What was noticed, so a screen can sort or group by it without re-reading the sentence. */
export type SupplierEvidenceKind =
  | "same-name" // identical once punctuation and "Inc." are set aside
  | "written-inside" // one name has the other written in its own brackets
  | "same-words" // same name, differing only by a shared trade word
  | "one-adds-words" // one is the other plus something, which may be a branch
  | "initials" // one name is the other's initials
  | "same-initials"; // two full names come out as the same initials, first words differ

export type SupplierMatch = {
  /** Both spellings exactly as scanned. */
  a: string;
  b: string;
  /** 0 to 1, the ordering key. Never shown as a percentage: it is not one. */
  score: number;
  confidence: SupplierConfidence;
  evidence: SupplierEvidenceKind[];
  /** Plain sentences for the person deciding. No jargon, no em-dashes. */
  reasons: string[];
};

type Ev = { kind: SupplierEvidenceKind; score: number; reason: string };

/** Quote words for a sentence, capitalised. The tokens inside are normalised and lowercased; a
 *  person reading "half the suppliers have hardware in the name" should see it written the way a
 *  name is written. */
const quoteList = (words: string[]) =>
  words.map((w) => `"${w.charAt(0).toUpperCase()}${w.slice(1)}"`).join(", ");

/** The first word of a name AS HE TYPED IT. Never the normalised token: "Mtn" normalises to
 *  "mountain", and a sentence that quotes a word back at him which is nowhere on his screen reads
 *  like the app is talking about some other supplier. */
const firstWordOf = (shape: SupplierNameShape) =>
  (shape.raw.match(/[A-Za-z0-9]+/)?.[0] ?? shape.core[0] ?? "").trim();
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((t) => b.includes(t));
const isSubset = (a: string[], b: string[]) => a.every((t) => b.includes(t));

/**
 * Everything noticed about one pair, strongest first. Split out from the public matcher because
 * suggestSupplierGroups has to be able to WEAKEN one piece of evidence (initials that fit more
 * than one supplier) before grading, and re-deriving the sentence over there is how the two would
 * come to disagree later.
 */
function evidenceFor(A: SupplierNameShape, B: SupplierNameShape): Ev[] {
  const ev: Ev[] = [];
  if (!A.key || !B.key) return ev;

  if (A.key === B.key) {
    ev.push({
      kind: "same-name",
      score: 1,
      reason: 'These read as the same name once the punctuation and words like "Inc." are set aside.',
    });
  }

  // The person already wrote the equivalence down: "Consolidated Electrical Distributors, Inc.
  // (CED)" says in its own brackets what it is called for short.
  for (const [outer, inner] of [
    [A, B],
    [B, A],
  ] as const) {
    const hit = outer.asides.find((s) => s.key === inner.key);
    if (hit) {
      ev.push({
        kind: "written-inside",
        score: 0.9,
        reason: `"${outer.raw}" has "${hit.text}" written inside it, and that is this other spelling exactly.`,
      });
      break;
    }
  }

  if (A.key !== B.key && A.distinctive.length > 0 && B.distinctive.length > 0) {
    if (sameSet(A.distinctive, B.distinctive)) {
      // Whatever is left over is a trade word by construction, so name it and say so.
      const extras = [
        ...new Set([...A.core, ...B.core].filter((t) => !A.core.includes(t) || !B.core.includes(t))),
      ];
      /**
       * WHEN ONE DISTINCTIVE WORD IS ALL THERE IS, THE TRADE WORD *IS* THE COMPANY (review, 2026-09-19).
       *
       * The rule above - a shared trade word can never hold a match up on its own - is what keeps
       * "Ace Mountain Hardware" away from "Mountain Hardware and Sports", and it is right. But run
       * it on two names that reduce to a SINGLE distinctive word and it argues the wrong way round:
       * "Ace Hardware" and "Ace Rentals" both reduce to {ace}, so this branch called them the same
       * name apart from a word half the suppliers in town have - and proposed merging a hardware
       * store's money into an equipment yard's. When "Ace" is the only word carrying weight, the
       * word that differs is the whole rest of the name, and only Erik knows whether one company or
       * two stands behind it. So it drops to a question instead of a proposal.
       */
      const onlyA = A.core.filter((t) => !B.core.includes(t));
      const onlyB = B.core.filter((t) => !A.core.includes(t));
      // BOTH sides must carry a trade word the other lacks. That is the difference between two
      // names pulling apart ("Ace Hardware" / "Ace Rentals" - a hardware store and an equipment
      // yard) and one name simply written shorter ("Swigards" / "Swigard's Hardware" - the same
      // counter, and a pair this rule broke on its first attempt by treating a missing word as a
      // conflicting one).
      const thin = A.distinctive.length === 1 && onlyA.length > 0 && onlyB.length > 0;
      ev.push({
        kind: "same-words",
        score: thin ? 0.45 : 0.78,
        reason: thin
          ? `Both start with ${quoteList(A.distinctive)} and then differ: ${quoteList(extras)}. With only one word in common that can be one company or two, and only you know which.`
          : extras.length
            ? `Same name apart from ${quoteList(extras)}, which is the kind of word half the suppliers in town have.`
            : "Same name, written two ways.",
      });
    } else if (
      A.distinctive[0] === B.distinctive[0] &&
      (isSubset(A.distinctive, B.distinctive) || isSubset(B.distinctive, A.distinctive))
    ) {
      // Same first word, one carries extra. Often a branch ("CED Sunnyvale"), sometimes a
      // different company entirely. Never strong enough to group on.
      const [shorter, longer] = A.distinctive.length <= B.distinctive.length ? [A, B] : [B, A];
      const extras = longer.distinctive.filter((t) => !shorter.distinctive.includes(t));
      ev.push({
        kind: "one-adds-words",
        score: 0.5,
        reason: `"${longer.raw}" is "${shorter.raw}" plus ${quoteList(extras)}. That can be a branch on the same account, or a different company.`,
      });
    }
  }

  // One side IS the initials of the other. Decent on its own, and deliberately weakened by the
  // caller when those initials fit more than one supplier in the book.
  for (const [short, full] of [
    [A, B],
    [B, A],
  ] as const) {
    if (short.isInitialism && full.core.length > 1 && short.key === full.initials) {
      ev.push({
        kind: "initials",
        score: 0.7,
        reason: `"${short.raw}" is the initials of "${full.raw}".`,
      });
      break;
    }
  }

  // Two full names that come out as the same initials but start with different words. This is
  // exactly Consolidated against Contractors: worth putting in front of him, never worth acting on.
  if (
    !A.isInitialism &&
    !B.isInitialism &&
    A.key !== B.key &&
    A.core.length > 1 &&
    A.initials === B.initials &&
    A.core[0] !== B.core[0]
  ) {
    const shared = A.core.filter((t) => B.core.includes(t)).length;
    ev.push({
      kind: "same-initials",
      score: 0.45,
      reason:
        `Both come out as the same initials (${A.initials.toUpperCase()})` +
        (shared ? ` and they share ${shared} of their ${A.core.length} words` : "") +
        `, but the first word is different: "${firstWordOf(A)}" against "${firstWordOf(B)}". ` +
        "That can be one account used at two separately owned branches, or two different companies. Only you know which.",
    });
  }

  return ev.sort((x, y) => y.score - x.score);
}

function gradeOf(score: number): SupplierConfidence {
  if (score >= 0.9) return "strong";
  if (score >= 0.7) return "likely";
  return "possible";
}

function fromEvidence(a: string, b: string, ev: Ev[]): SupplierMatch | null {
  if (!ev.length) return null;
  const score = ev[0].score;
  return {
    a,
    b,
    score,
    confidence: gradeOf(score),
    evidence: ev.map((e) => e.kind),
    reasons: ev.map((e) => e.reason),
  };
}

/**
 * Are these two spellings the same supplier? Returns the suggestion and the reasons, or null when
 * there is nothing worth saying. Two identical strings return null: there is no suggestion to be
 * made about a name and itself.
 */
export function matchSupplierNames(a: string, b: string): SupplierMatch | null {
  if (String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase()) return null;
  return fromEvidence(a, b, evidenceFor(readSupplierName(a), readSupplierName(b)));
}

export type SupplierGroupSuggestion = {
  /** The fullest, cleanest spelling in the group, offered as the account name. A starting point
   *  for the name box, not the name: supplier_accounts.name is whatever he types. */
  suggestedName: string;
  /** Every spelling proposed for this account, as scanned. */
  members: string[];
  /** The WEAKEST join in the group. A group is only as sound as the thinnest thread holding it. */
  confidence: SupplierConfidence;
  /** One sentence per join. */
  reasons: string[];
};

export type SupplierIdentitySuggestions = {
  /** Spellings that look like one account. Still a proposal: nothing is written until he says so. */
  groups: SupplierGroupSuggestion[];
  /** Pairs worth his eye that were deliberately NOT grouped, each carrying the reason it stopped
   *  short. This is where "Contractors Electrical Distributors" lands. */
  candidates: SupplierMatch[];
};

/** Fullest and cleanest: most meaningful words first, then the least punctuation, then the
 *  longest. "Consolidated Electrical Distributors" beats both "CED" and the one trailing
 *  ", Inc. (CED)"; "Ace Mountain Hardware" beats "Ace - Mountain Hardware". */
function pickHeadName(members: string[]): string {
  const scored = members.map((m) => ({
    m,
    words: readSupplierName(m).core.length,
    noise: (m.match(/[^A-Za-z0-9]/g) ?? []).length,
  }));
  scored.sort((x, y) => y.words - x.words || x.noise - y.noise || y.m.length - x.m.length);
  return scored[0]?.m ?? "";
}

/**
 * THE WHOLE BOOK AT ONCE, which is the only place ambiguity is visible.
 *
 * Pairwise, "CED" is the initials of "Consolidated Electrical Distributors" and a fine suggestion.
 * Pairwise, "CED" is ALSO the initials of "Contractors Electrical Distributors". One pair at a
 * time both look convincing, and a union of the two would quietly fold a Sunnyvale storefront's
 * money into the Truckee account. So initials that fit more than one supplier are knocked down to
 * a question here, naming every name they fit, and a group is never formed on them.
 *
 * (The CED spellings still come out as one group, because "Consolidated Electrical Distributors,
 * Inc. (CED)" carries the answer in its own brackets. That is Erik's writing, not our guess.)
 */
export function suggestSupplierGroups(
  names: (string | null | undefined)[] | null | undefined,
): SupplierIdentitySuggestions {
  // One entry per spelling. Case is not a spelling: supplier_aliases is unique on lower(alias).
  const seen = new Map<string, string>();
  for (const n of names ?? []) {
    const raw = String(n ?? "").trim();
    if (!raw) continue;
    const k = raw.toLowerCase();
    if (!seen.has(k)) seen.set(k, raw);
  }
  const list = [...seen.values()];
  const shapes = list.map(readSupplierName);

  // Which initialisms fit more than one distinct name.
  const alternativesFor = new Map<number, string[]>();
  shapes.forEach((s, i) => {
    if (!s.isInitialism) return;
    const fits = new Map<string, string>();
    shapes.forEach((o, j) => {
      if (i === j || o.core.length < 2) return;
      if (o.initials === s.key && !fits.has(o.key)) fits.set(o.key, o.raw);
    });
    if (fits.size > 1) alternativesFor.set(i, [...fits.values()]);
  });

  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  const joins: { i: number; j: number; match: SupplierMatch }[] = [];
  const asked: { i: number; j: number; match: SupplierMatch }[] = [];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      let ev = evidenceFor(shapes[i], shapes[j]);
      const ambiguousSide = alternativesFor.has(i) ? i : alternativesFor.has(j) ? j : null;
      if (ambiguousSide !== null && ev.some((e) => e.kind === "initials")) {
        const alts = alternativesFor.get(ambiguousSide) ?? [];
        ev = ev.map((e) =>
          e.kind !== "initials"
            ? e
            : {
                kind: "initials",
                score: 0.45,
                reason:
                  `"${shapes[ambiguousSide].raw}" is the initials of more than one supplier on this list ` +
                  `(${quoteList(alts)}). Initials alone will not say which account it is.`,
              },
        );
        ev.sort((x, y) => y.score - x.score);
      }
      const match = fromEvidence(list[i], list[j], ev);
      if (!match) continue;
      if (match.confidence === "possible") asked.push({ i, j, match });
      else {
        joins.push({ i, j, match });
        union(i, j);
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  list.forEach((_, i) => {
    const r = find(i);
    byRoot.set(r, [...(byRoot.get(r) ?? []), i]);
  });

  const groups: SupplierGroupSuggestion[] = [];
  const headOf = new Map<number, string>();
  for (const [root, idx] of byRoot) {
    const members = idx.map((i) => list[i]);
    const head = members.length > 1 ? pickHeadName(members) : members[0];
    for (const i of idx) headOf.set(i, head);
    if (members.length < 2) continue;
    const mine = joins.filter((j) => find(j.i) === root);
    groups.push({
      suggestedName: head,
      members,
      confidence: mine.some((j) => j.match.confidence === "likely") ? "likely" : "strong",
      reasons: [...new Set(mine.map((j) => j.match.reasons[0]))],
    });
  }
  groups.sort((a, b) => b.members.length - a.members.length || a.suggestedName.localeCompare(b.suggestedName));

  // One question per pair of ACCOUNTS, not per pair of spellings: "Contractors Electrical
  // Distributors" against four Consolidated spellings is one question, asked once.
  const bestPerPair = new Map<string, SupplierMatch>();
  for (const { i, j, match } of asked) {
    if (find(i) === find(j)) continue; // already proposed as one account
    const key = [headOf.get(i) ?? list[i], headOf.get(j) ?? list[j]].sort().join(" >< ");
    const prev = bestPerPair.get(key);
    if (!prev || match.score > prev.score) bestPerPair.set(key, match);
  }
  const candidates = [...bestPerPair.values()].sort((x, y) => y.score - x.score || x.a.localeCompare(y.a));

  return { groups, candidates };
}

/**
 * THE KEY THE DATABASE ITSELF USES, and deliberately nothing cleverer.
 *
 * supplier_aliases carries `unique index on (org_id, lower(alias))`, so this is lower() with the
 * whitespace trimmed and NOT the normalising above. That is not laziness, it is the only way the
 * app and the constraint can agree: a key that folded punctuation would have the app refuse
 * "C.E.D." as already taken by "CED" while the database would happily accept it, which is a
 * refusal with no way forward for something that was never a conflict. Two different questions,
 * two different functions:
 *
 *   · "is this the same STRING?"  -> aliasKey, exact, load-bearing, decides what gets written
 *   · "is this the same COMPANY?" -> suggestSupplierGroups, fuzzy, only ever a suggestion
 *
 * Anything that filters or updates BILLS by supplier text must use this one. Matching bills with
 * the fuzzy key would re-file rows he never pointed at.
 */
export function aliasKey(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** spelling -> account id, built once per page instead of scanning the alias list per bill. */
export type SupplierAliasIndex = Map<string, string>;

export function indexSupplierAliases(
  rows: { alias?: string | null; supplier_account_id?: string | null }[] | null | undefined,
): SupplierAliasIndex {
  const index: SupplierAliasIndex = new Map();
  for (const r of rows ?? []) {
    const key = aliasKey(r?.alias);
    const id = String(r?.supplier_account_id ?? "");
    // First one wins; the unique index means there should never be a second.
    if (key && id && !index.has(key)) index.set(key, id);
  }
  return index;
}

/**
 * THE ONLY AUTOMATIC MAPPING THERE IS: an exact alias, which exists because a person already
 * pressed something to create it. Everything fuzzy in this file ends at a button; this is what
 * happens AFTER the button. A miss returns null, meaning "not filed to an account yet", never a
 * guess.
 */
export function accountForSupplier(
  supplier: string | null | undefined,
  index: SupplierAliasIndex | null | undefined,
): string | null {
  const key = aliasKey(supplier);
  if (!key || !index) return null;
  return index.get(key) ?? null;
}

/** The same lookup against a plain array, for a caller holding one small list. Built on the index
 *  so there is exactly one rule for what counts as the same spelling. */
export function resolveSupplierAccount(
  supplier: string | null | undefined,
  aliases: { alias?: string | null; supplier_account_id?: string | null }[] | null | undefined,
): string | null {
  return accountForSupplier(supplier, indexSupplierAliases(aliases));
}

// ── THE INVOICE NUMBER THE APP ALREADY HAS AND THROWS AWAY ───────────────────────────────────
//
// CED's portal names every PDF `TR-34426_20260616_32136931_15165103264.pdf`: account, date,
// invoice number, and its own internal id. The importer files that whole string in bills.notes as
// "Receipt recorded as cost: TR-34426_..." while bills.bill_number sits EMPTY on all 21 bills. So
// "I sent CED $4,000" could not be matched to anything CED lists when they ask which invoices it
// covered, even though the numbers were sitting in the notes the whole time.

/** What a CED portal filename says. Every field read, none inferred. */
export type SupplierFileRef = {
  /** "TR-34426". His account number, as the portal wrote it. */
  accountNumber: string;
  /** "2026-06-16". */
  date: string;
  /** "32136931". The number the portal uses for the document. */
  invoiceNumber: string;
  /** The trailing internal id. Kept because it is there, not because anything reads it yet. */
  internalId: string;
};

/** The prefixes the two importers write ahead of the filename (organize/actions.ts). A note can
 *  also carry the receipt-reconciliation sentence on the lines below, so only the first line is
 *  ever read as a filename. */
const NOTE_PREFIX = /^\s*receipt\s+(?:recorded\s+as\s+cost|filed\s+by\s+organize\s+my)\s*:\s*/i;

/** A real calendar day, or null. "20261345" is not a date and must never become one. */
function ymdFrom(digits: string): string | null {
  const y = Number(digits.slice(0, 4));
  const m = Number(digits.slice(4, 6));
  const d = Number(digits.slice(6, 8));
  if (!(y >= 2000 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/**
 * Read a CED portal filename, from a bare name or straight out of bills.notes with either
 * importer prefix on the front.
 *
 * Returns null, never a guess, for everything else: "image.jpg", "85 Whit.pdf",
 * "85 Whitney Pl - CED.pdf". A wrong invoice number on a supplier payment is worse than no number
 * at all, because a missing one is visibly missing and a wrong one is not.
 */
export function parseSupplierFilename(raw: string | null | undefined): SupplierFileRef | null {
  const firstLine = String(raw ?? "").split(/\r?\n/)[0] ?? "";
  const name = firstLine.replace(NOTE_PREFIX, "").trim().replace(/\.[A-Za-z0-9]{2,4}$/, "").trim();
  const m = /^([A-Za-z]{1,4}-?\d{3,8})_(\d{8})_(\d{3,12})_(\d{3,16})$/.exec(name);
  if (!m) return null;
  const date = ymdFrom(m[2]);
  if (!date) return null;
  return { accountNumber: m[1], date, invoiceNumber: m[3], internalId: m[4] };
}

/** What the OCR'd lines of one bill say about invoice numbers. */
export type BillInvoiceNumbers = {
  /** Every distinct number found, in the order they appear. */
  numbers: string[];
  /** More than one number on one document means it is a STATEMENT, which is what arrived in his
   *  email import. bills.is_statement exists for exactly this. */
  isStatement: boolean;
  /** The one number, when there is exactly one. Null for none AND null for a statement, because
   *  a statement does not have one. */
  invoiceNumber: string | null;
};

/** "(Invoice 8802-1101363)", "(Inv. 8802-1105963)". The reader captured these inside line
 *  descriptions like "Sales Tax 9.00000 (Invoice 8802-1101363)" because the ticket printed them
 *  there, and nothing has ever looked. */
const IN_LINE = /\(\s*(?:invoice|inv)\.?\s*(?:no\.?|number|#)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9./-]{2,})\s*\)/gi;

export function invoiceNumbersInLines(
  descriptions: (string | null | undefined)[] | null | undefined,
): BillInvoiceNumbers {
  const numbers: string[] = [];
  const seen = new Set<string>();
  for (const d of descriptions ?? []) {
    const text = String(d ?? "");
    if (!text) continue;
    for (const m of text.matchAll(IN_LINE)) {
      const n = String(m[1] ?? "").replace(/[.\-/]+$/, "").trim();
      if (!n) continue;
      const k = n.toUpperCase();
      if (seen.has(k)) continue;
      seen.add(k);
      numbers.push(n);
    }
  }
  return {
    numbers,
    isStatement: numbers.length > 1,
    invoiceNumber: numbers.length === 1 ? numbers[0] : null,
  };
}

export type BillInvoiceReading = BillInvoiceNumbers & {
  /** Where the number came from, so a screen can say so and he can disbelieve it. */
  source: "filename" | "lines" | null;
  /** The filename reading in full, when the notes carried one. */
  file: SupplierFileRef | null;
};

/**
 * Everything one bill can tell us about the supplier's own number for it, in one reading.
 *
 * ORDER, and the honesty in it: if the lines carry more than one number the document is a
 * STATEMENT and has no single number, whatever the file was called. Otherwise the portal filename
 * wins, because the portal wrote it and OCR merely read it.
 *
 * These are two different numbering spaces and this deliberately does not pretend otherwise: the
 * filename carries CED's document number (32136931) while the ticket prints the branch-prefixed
 * invoice (8802-1101363). `source` rides along on the result so a screen can say which one he is
 * looking at, instead of showing a bare number that matches nothing on his statement.
 */
export function readBillInvoice(input: {
  notes?: string | null;
  lineDescriptions?: (string | null | undefined)[] | null;
}): BillInvoiceReading {
  const fromLines = invoiceNumbersInLines(input?.lineDescriptions);
  const file = parseSupplierFilename(input?.notes);
  if (fromLines.isStatement) return { ...fromLines, source: "lines", file };
  if (file) {
    return {
      numbers: [file.invoiceNumber],
      isStatement: false,
      invoiceNumber: file.invoiceNumber,
      source: "filename",
      file,
    };
  }
  if (fromLines.invoiceNumber) return { ...fromLines, source: "lines", file: null };
  return { numbers: [], isStatement: false, invoiceNumber: null, source: null, file: null };
}

/** One plain sentence about what was found, for the bill row. Hyphens, never em-dashes. */
export function describeInvoiceReading(r: BillInvoiceReading): string {
  if (r.isStatement) {
    return `This one is a statement covering ${r.numbers.length} of their invoices (${r.numbers.join(", ")}), so it has no single invoice number.`;
  }
  if (r.source === "filename" && r.file) {
    return `Invoice ${r.file.invoiceNumber}, read off the file name their portal gave it (account ${r.file.accountNumber}, ${r.file.date}).`;
  }
  if (r.source === "lines" && r.invoiceNumber) {
    return `Invoice ${r.invoiceNumber}, read off a line on the receipt.`;
  }
  return "No invoice number found on this one.";
}

// ── THE SAME TICKET, FILED TWICE ─────────────────────────────────────────────────────────────

/** Just enough of a bill to tell two of them apart. */
export type BillFingerprint = {
  id: string;
  /** Whatever the scanner typed, or the account name once one exists. */
  supplier?: string | null;
  amount: number;
  billDate?: string | null;
  /** What the job is called on screen, so the question can name both sides. */
  jobLabel?: string | null;
  /** How many lines the reader transcribed. Two tickets to the penny with the same number of
   *  lines is the shape of one ticket filed twice. */
  lineCount?: number | null;
  invoiceNumber?: string | null;
};

export type DuplicateBillSuggestion = {
  bills: [BillFingerprint, BillFingerprint];
  amount: number;
  /** Plain words, naming both jobs, and saying out loud that nothing gets picked for him. */
  reason: string;
};

/**
 * TWO BILLS THAT LOOK LIKE ONE TICKET (found in his book, 2026-09-18).
 *
 * An identical CED ticket, line for line to the penny ($95.27, 8 lines), is filed BOTH to "13631
 * Northwoods" (07-29, from TR-34426_20260730_32270817_...pdf) and to "85 Whitney Place" (08-28,
 * from "85 Whit.pdf"). One of those two jobs is carrying a cost that is not its own, which quietly
 * moves real profit from one job to the other.
 *
 * WHICH ONE IS WRONG IS NOT KNOWABLE FROM HERE, and two identical counter runs a month apart are a
 * perfectly ordinary thing for an electrician to do. So this only ever asks. It does not delete,
 * it does not re-file, and it does not rank one job over the other. The test is deliberately
 * tight: the same supplier, the same amount to the penny, and either the same invoice number or
 * the same number of transcribed lines. Amount alone would cry wolf on every $20 box of wire nuts.
 */
export function findDuplicateBills(
  bills: BillFingerprint[] | null | undefined,
): DuplicateBillSuggestion[] {
  const rows = (bills ?? []).filter((b) => b && Number.isFinite(Number(b.amount)) && Number(b.amount) > 0);
  const out: DuplicateBillSuggestion[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (Math.round(Number(a.amount) * 100) !== Math.round(Number(b.amount) * 100)) continue;
      const sa = normalizeSupplierName(a.supplier);
      if (!sa || sa !== normalizeSupplierName(b.supplier)) continue;
      const sameInvoice =
        !!a.invoiceNumber &&
        String(a.invoiceNumber).toUpperCase() === String(b.invoiceNumber ?? "").toUpperCase();
      const sameLines =
        Number.isFinite(Number(a.lineCount)) &&
        Number(a.lineCount) > 0 &&
        Number(a.lineCount) === Number(b.lineCount);
      if (!sameInvoice && !sameLines) continue;
      const amount = Math.round(Number(a.amount) * 100) / 100;
      const where = (x: BillFingerprint) =>
        `${x.jobLabel ? x.jobLabel : "no job"}${x.billDate ? ` on ${x.billDate}` : ""}`;
      const how = sameInvoice
        ? ` (invoice ${a.invoiceNumber})`
        : ` with the same ${Number(a.lineCount)} lines`;
      out.push({
        bills: [a, b],
        amount,
        reason:
          `The same ${a.supplier || "supplier"} ticket for $${amount.toFixed(2)}${how} is filed to ${where(a)} ` +
          `and again to ${where(b)}. If that was one trip, one of these jobs is carrying a cost that is not its own. ` +
          "Two identical runs a month apart are also perfectly normal, so nothing changes here until you say which.",
      });
    }
  }
  return out;
}
