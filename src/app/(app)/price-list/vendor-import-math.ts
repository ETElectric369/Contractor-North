import { matchSupplierNames } from "@/lib/supplier-identity";
import { vendorKey, type VendorKind } from "./item-options-math";
import { applyPick, type FoundField, type LookupChoice } from "./vendor-lookup-math";

/**
 * A VENDOR LIST, DROPPED ON THE VENDORS TAB, SORTED FOR A PERSON TO DECIDE (vendor import,
 * Phase 1, 2026-09-25).
 *
 * Andrew (Vivian Builders) dropped Vivian_Builders_Vendors.xlsx: one column, a "Vendor Name"
 * heading, 29 names. Most are subcontractors, some are suppliers, one is a person, and some nobody
 * can tell from the name. This file turns the rows of any list (xlsx, CSV, text, a PDF's text) into
 * a PREVIEW: every row with a guessed Kind and trade, plain-word notes, and a tick.
 *
 * THE APP SUGGESTS, A PERSON DECIDES. Everything here is a guess, labelled as one, and changeable:
 *   · Kind comes from a keyword table on the name and is always shown as "Guessed From The Name".
 *     A name it can't read is Not Sorted, never forced into a kind.
 *   · "Already Have" is an EXACT match (vendorKey, the same key the one-per-name index uses).
 *   · "Same Company?" is a FUZZY match (matchSupplierNames: legal forms and punctuation stripped,
 *     graded with evidence). Its tick starts OFF and nothing is ever merged.
 *   · Nothing is saved here. Saving is addVendorsBatch, after a person presses Add.
 *
 * Pure and client-safe, so every rule is tested with made-up names.
 */

export const IMPORT_MAX_ROWS = 200;
const NAME_MAX = 120;

export type ImportField = "name" | "contact_name" | "phone" | "email" | "website" | "address" | "city" | "state" | "zip" | "trade";
export type ColumnMap = Partial<Record<ImportField, number>>;

/** One row read out of the file, before any guessing. `line` is its row in the file (1-based). */
export interface RawVendorRow {
  line: number;
  name: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  trade?: string;
}

/* ── HEADINGS ─────────────────────────────────────────────────────────────────────────────── */

/** Words a heading cell is made of. A cell is a heading only when EVERY word in it is one of
 *  these, so "Vendor Name" is a heading and a vendor called "Supplier Co" is not. */
const HEADING_WORDS = new Set([
  "vendor", "vendors", "name", "names", "company", "companies", "supplier", "suppliers", "sub", "subs",
  "subcontractor", "subcontractors", "contractor", "contractors", "business", "businesses", "list",
  "contact", "contacts", "person", "rep", "representative", "phone", "phones", "number", "no", "num",
  "mobile", "cell", "tel", "telephone", "email", "emails", "e", "mail", "address", "street", "city",
  "state", "zip", "postal", "code", "website", "web", "site", "url", "homepage", "notes", "note",
  "trade", "trades", "type", "kind", "category", "full", "first", "last", "main", "office", "of",
]);

const FIELD_HEADINGS: [ImportField, RegExp][] = [
  // Order matters: "Contact Name" is the contact, not the vendor's name; "Company Phone" is a phone.
  ["email", /e-?\s?mail/i],
  ["phone", /phone|mobile|cell|\btel\b|telephone/i],
  ["website", /web|url|\bsite\b|homepage/i],
  ["contact_name", /contact|\brep\b|representative|person/i],
  ["city", /\bcity\b/i],
  ["state", /\bstate\b/i],
  ["zip", /\bzip\b|postal/i],
  ["address", /address|street/i],
  ["trade", /trade|\btype\b|\bkind\b|category/i],
  ["name", /vendor|company|supplier|business|\bsubs?\b|subcontractor|contractor|name/i],
];

function words(cell: string): string[] {
  return cell
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Is this row the list's headings? Every non-empty cell must be made only of heading words. */
export function looksLikeHeader(row: string[]): boolean {
  const cells = row.map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!cells.length) return false;
  return cells.every((c) => {
    const w = words(c);
    return w.length > 0 && w.length <= 4 && w.every((x) => HEADING_WORDS.has(x));
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+()\d\s.\-x]{7,}$/i;
const SITE = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
const digitsIn = (s: string) => s.replace(/\D/g, "").length;

/** What a column holds, judged from its cells when there is no heading to say. */
function sniff(cells: string[]): "email" | "phone" | "website" | "text" | "empty" {
  const vals = cells.map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!vals.length) return "empty";
  const share = (f: (v: string) => boolean) => vals.filter(f).length / vals.length;
  if (share((v) => EMAIL.test(v)) >= 0.6) return "email";
  if (share((v) => PHONE.test(v) && digitsIn(v) >= 7 && digitsIn(v) <= 15) >= 0.6) return "phone";
  if (share((v) => SITE.test(v) && !EMAIL.test(v)) >= 0.6) return "website";
  return "text";
}

/**
 * Which column is which. A heading row names them; without one, the columns are read by what they
 * hold (emails, phone numbers, websites), and the first column of words is the names. One column
 * is always the names.
 */
export function pickColumns(table: string[][]): { header: boolean; columns: ColumnMap } {
  const width = Math.max(0, ...table.map((r) => r.length));
  const header = table.length > 0 && looksLikeHeader(table[0]);
  const columns: ColumnMap = {};
  const taken = new Set<number>();
  if (header) {
    const heads = table[0].map((c) => String(c ?? "").trim());
    for (const [field, re] of FIELD_HEADINGS) {
      const i = heads.findIndex((h, idx) => h && !taken.has(idx) && re.test(h));
      if (i >= 0) {
        columns[field] = i;
        taken.add(i);
      }
    }
  }
  const body = header ? table.slice(1) : table;
  if (columns.name === undefined) {
    for (let i = 0; i < width; i++) {
      if (taken.has(i)) continue;
      const kind = sniff(body.map((r) => r[i] ?? ""));
      if (!header && (kind === "email" || kind === "phone" || kind === "website")) {
        if (columns[kind] === undefined) {
          columns[kind] = i;
          taken.add(i);
        }
        continue;
      }
      if (kind === "text" && columns.name === undefined) {
        columns.name = i;
        taken.add(i);
      }
    }
  }
  return { header, columns };
}

/**
 * The file's rows as vendor rows: heading skipped, blank names left out, at most 200 kept (the
 * rest counted, so the preview can say how many were left out, never silently).
 */
export function rowsFromTable(table: string[][]): { rows: RawVendorRow[]; headerSkipped: boolean; overCap: number; columns: ColumnMap } {
  const { header, columns } = pickColumns(table);
  const start = header ? 1 : 0;
  const rows: RawVendorRow[] = [];
  let overCap = 0;
  const cell = (r: string[], f: ImportField) => (columns[f] === undefined ? "" : String(r[columns[f] as number] ?? "").replace(/\s+/g, " ").trim());
  for (let i = start; i < table.length; i++) {
    const r = table[i];
    const name = cell(r, "name");
    if (!name) continue;
    if (rows.length >= IMPORT_MAX_ROWS) {
      overCap++;
      continue;
    }
    const street = cell(r, "address");
    const cityLine = [cell(r, "city"), [cell(r, "state"), cell(r, "zip")].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const address = [street, cityLine].filter(Boolean).join(", ");
    const row: RawVendorRow = { line: i + 1, name };
    for (const f of ["contact_name", "phone", "email", "website", "trade"] as const) {
      const v = cell(r, f);
      if (v) row[f] = v;
    }
    if (address) row.address = address;
    rows.push(row);
  }
  return { rows, headerSkipped: header, overCap, columns };
}

/** A PDF's text (or any plain list): one name per line. Numbered and bulleted lines lose the
 *  number or bullet; lines that are only numbers or punctuation are dropped. */
export function tableFromLines(text: string): string[][] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d{1,3}[.)])\s+/, "").replace(/\s+/g, " ").trim())
    .filter((l) => /[A-Za-z]/.test(l))
    .map((l) => [l]);
}

/* ── KIND AND TRADE, GUESSED FROM THE NAME ──────────────────────────────────────────────────── */

/** Words that make a name a SUPPLIER whatever else it says: "Tahoe Plumbing Supply" sells pipe. */
const SUPPLIER_FIRST: [RegExp, string | null][] = [
  [/\bsuppl(?:y|ies)\b/i, null],
  [/\bdistribut(?:ors?|ing|ion)\b/i, null],
  [/\bwholesale(?:rs?)?\b/i, null],
  [/\blumber\b/i, "Lumber"],
  [/\bbuilding materials?\b/i, "Building Materials"],
  [/\bhardware\b/i, "Hardware"],
];

/** Trades a subcontractor does, in the order they are checked. The general words (construction,
 *  builders) come last so "Birch Concrete Construction" reads as Concrete. */
const SUB_TRADES: [RegExp, string][] = [
  [/\bplumb(?:ing|ers?)?\b/i, "Plumbing"],
  [/\broof(?:ing|ers?)?\b/i, "Roofing"],
  [/\bpaint(?:ing|ers?)?\b/i, "Painting"],
  [/\bdrywall\b|\bsheetrock\b/i, "Drywall"],
  [/\bconcrete\b/i, "Concrete"],
  [/\bmasonry\b|\bmason\b/i, "Masonry"],
  [/\bstucco\b|\bplaster(?:ing)?\b/i, "Stucco"],
  [/\binsulat(?:ion|ing|ors?)\b/i, "Insulation"],
  [/\bmechanical\b/i, "Mechanical"],
  [/\bhvac\b|\bheating\b|\bhydronics?\b|\bair conditioning\b/i, "Heating"],
  [/\belectric(?:al|ians?)?\b/i, "Electrical"],
  [/\bsolar\b/i, "Solar"],
  [/\bcabinet(?:s|ry)?\b/i, "Cabinets"],
  [/\bepoxy\b/i, "Epoxy"],
  [/\bfloor(?:s|ing)?\b|\btile\b/i, "Flooring"],
  [/\bframing\b|\bframers?\b/i, "Framing"],
  [/\bsiding\b/i, "Siding"],
  [/\bgutters?\b/i, "Gutters"],
  [/\bexcavat(?:ion|ing)\b|\bgrading\b|\bearthwork\b|\bpaving\b|\bseptic\b/i, "Excavation"],
  [/\blandscap(?:e|ing|ers?)\b/i, "Landscaping"],
  [/\bfenc(?:e|es|ing)\b/i, "Fencing"],
  [/\bdemolition\b|\bdemo\b/i, "Demolition"],
  [/\bcarpentry\b|\bcarpenters?\b|\bfinish work\b/i, "Carpentry"],
  [/\bweld(?:ing|ers?)\b/i, "Welding"],
  [/\bsprinklers?\b|\bfire protection\b/i, "Fire Sprinklers"],
  [/\bengineer(?:s|ing)?\b/i, "Engineering"],
  [/\bsurvey(?:s|ing|ors?)?\b/i, "Surveying"],
  [/\bclean(?:ing|ers?)\b|\bjanitorial\b/i, "Cleaning"],
  [/\bconstruction\b|\bbuilders?\b|\bcontract(?:ing|ors?)\b|\bremodel(?:ing|ers?)?\b/i, "Construction"],
];

/** Things a supplier sells: "Lakeside Windows", "Northgate Iron", "Ridge Glass". */
const SUPPLIER_GOODS: [RegExp, string][] = [
  [/\bwindows?\b/i, "Windows"],
  [/\bdoors?\b/i, "Doors"],
  [/\bglass\b/i, "Glass"],
  [/\bmetals?\b/i, "Metals"],
  [/\biron\b/i, "Iron"],
  [/\bsteel\b/i, "Steel"],
  [/\bmouldings?\b|\bmoldings?\b|\bmillwork\b/i, "Millwork"],
  [/\btruss(?:es)?\b/i, "Trusses"],
  [/\bappliances?\b/i, "Appliances"],
  [/\bstone\b|\bgranite\b|\bquartz\b/i, "Stone"],
];

/**
 * The kind and trade a name suggests, or null for both when the name doesn't say ("Ridgeline West",
 * "Heavy Haul"). Deterministic: the same name always guesses the same way. Always shown as a
 * guess, and one tap changes it.
 */
export function guessKind(name: string): { kind: VendorKind | null; trade: string | null } {
  const n = String(name ?? "");
  for (const [re, trade] of SUPPLIER_FIRST) {
    if (re.test(n)) {
      const goods = SUPPLIER_GOODS.find(([g]) => g.test(n))?.[1] ?? SUB_TRADES.find(([g, t]) => t !== "Construction" && g.test(n))?.[1];
      return { kind: "supplier", trade: trade ?? goods ?? null };
    }
  }
  const sub = SUB_TRADES.find(([re]) => re.test(n));
  const goods = SUPPLIER_GOODS.find(([re]) => re.test(n));
  // A specific trade beats the goods ("Pro Glass Painting" paints); the goods beat the general
  // word ("Truckee Door Construction" is still about doors).
  if (sub && sub[1] !== "Construction") return { kind: "subcontractor", trade: sub[1] };
  if (goods) return { kind: "supplier", trade: goods[1] };
  if (sub) return { kind: "subcontractor", trade: sub[1] };
  return { kind: null, trade: null };
}

/* ── A PERSON, NOT A COMPANY ──────────────────────────────────────────────────────────────── */

/** Words that make a name a business: legal forms and business nouns. */
const COMPANY_WORDS = /\b(inc|incorporated|llc|llp|lp|ltd|limited|corp|corporation|co|company|group|services?|enterprises?|associates|partners|industries|holdings|solutions|systems|brothers|bros|sons|and sons|studio|works|shop|store|center|equipment|equip|rentals?|west|east|north|south|pacific|sierra|tahoe|valley|mountain|alpine|apex|pro|elite|creative|infinity)\b|&|\d/i;

/** Common first names (US, including the Spanish names common in the trades). Not a census; a
 *  name that isn't here just isn't guessed, and the person can still tick "Person". */
const FIRST_NAMES = new Set(
  (
    "aaron adam adrian alan albert alberto alex alejandro alfredo alice amanda amy andrea andres andrew angel angela anna anthony antonio armando arturo ashley barbara ben benjamin bill billy bob bobby brad brandon brian bruce carl carlos carmen carol cesar charles chris christian christopher cindy claudia cody colin craig cristian dan daniel danny dave david dennis diana diego donald doug douglas dylan ed eddie eduardo edward edwin elena emily enrique eric erik ernesto esteban eugene felipe fernando francisco frank gabriel gary george gerardo gilbert gloria greg gregory guadalupe guillermo gustavo hector henry hugo ignacio ivan jack jacob jaime james jason javier jeff jeffrey jennifer jeremy jerry jesse jesus jim jimmy joe joel john johnny jon jonathan jorge jose joseph josh joshua juan julian julio justin karen kathy keith kelly ken kenneth kevin kyle larry laura leo leonardo linda lisa lorenzo louis lucas luis manuel marco marcos maria mario mark martin mary matt matthew michael miguel mike nancy nathan nick nicholas oscar pablo patricia patrick paul pedro peter rafael ramon randy ray raul rebecca ricardo richard rick rob robert roberto rodrigo roger ron ronald rosa ruben russell ryan salvador sam samuel sandra santiago sara sarah scott sean sergio shawn stephen steve steven susan terry thomas tim timothy todd tom tony travis tyler victor vincent walter wayne william"
  ).split(" "),
);

/**
 * Does this name look like a PERSON's? Two or three words, each a capitalised name (an initial
 * like "B." allowed), no business word, and a first word that is a common first name.
 * "Maria Delgado" yes; "Ridgeline West", "Heavy Haul", "Tom Smith Concrete" no.
 */
export function guessPerson(name: string): boolean {
  const n = String(name ?? "").trim();
  if (!n || COMPANY_WORDS.test(n)) return false;
  if (guessKind(n).kind) return false;
  const parts = n.split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return false;
  if (!parts.every((p) => /^[A-Z][A-Za-z'’-]*\.?$/.test(p))) return false;
  return FIRST_NAMES.has(parts[0].toLowerCase().replace(/\.$/, ""));
}

/* ── THE PREVIEW ──────────────────────────────────────────────────────────────────────────── */

/** A vendor the org already has, as the preview compares against it. */
export interface ExistingVendor {
  name: string;
  /** It has a card on price_list_vendors (0296). */
  card: boolean;
  /** That card is archived. */
  archived: boolean;
  /** Its name is on at least one item's vendor row. */
  onItems: boolean;
}

export type RowNoteKind = "person" | "already" | "archived" | "on-items" | "same-company" | "twice" | "too-long";
export interface RowNote {
  kind: RowNoteKind;
  text: string;
}

export interface PreviewRow {
  /** Stable key for React and for edits: the row's line in the file. */
  id: string;
  line: number;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  kind: VendorKind | null;
  trade: string | null;
  /** True while the kind is still the app's guess; false once a person picks one. */
  kindGuessed: boolean;
  is_person: boolean;
  /** How many times this exact name appears in the file (the preview keeps one). */
  copies: number;
  ticked: boolean;
  /** A looked-up choice a person picked (or the only one found), and which of its fields to take.
   *  It fills the row only: nothing is saved until Add (Look Up, Phase 2). */
  pick?: { choice: LookupChoice; take: FoundField[] } | null;
}

/** One Kind's words, for chips and selects. Title Case: they are clickable. */
export const KIND_LABEL: Record<VendorKind | "none", string> = {
  brand: "Brand",
  supplier: "Supplier",
  subcontractor: "Subcontractor",
  none: "Not Sorted",
};

/** The Kind choices, in the order the selects list them. "" is Not Sorted. */
export const KIND_CHOICES: { value: VendorKind | ""; label: string }[] = [
  { value: "supplier", label: KIND_LABEL.supplier },
  { value: "subcontractor", label: KIND_LABEL.subcontractor },
  { value: "brand", label: KIND_LABEL.brand },
  { value: "", label: KIND_LABEL.none },
];

/**
 * The notes a row carries, from what it says NOW (so they follow an edit to the name). Plain words,
 * and each one says what will happen or what to decide.
 */
export function notesFor(row: Pick<PreviewRow, "id" | "name" | "is_person" | "copies">, all: Pick<PreviewRow, "id" | "name">[], existing: ExistingVendor[]): RowNote[] {
  const notes: RowNote[] = [];
  const name = row.name.trim();
  const key = vendorKey(name);
  if (name.length > NAME_MAX) notes.push({ kind: "too-long", text: `That name is over ${NAME_MAX} characters. Shorten it to add it.` });
  if (row.is_person) {
    notes.push({
      kind: "person",
      text: `${name} looks like a person, not a company, so a lookup won't pick for you. Untick A Person if it's a company; it can be changed later on the vendor's sheet.`,
    });
  }
  if (row.copies > 1) notes.push({ kind: "twice", text: row.copies === 2 ? "In your file twice. It's added once." : `In your file ${row.copies} times. It's added once.` });

  const exact = existing.find((e) => vendorKey(e.name) === key);
  if (exact?.card && !exact.archived) {
    notes.push({ kind: "already", text: `Already Have: '${exact.name.trim()}' is on your Vendors list.` });
    return notes;
  }
  if (exact?.card && exact.archived) {
    notes.push({ kind: "archived", text: `You have '${exact.name.trim()}' archived. Adding it brings it back.` });
  } else if (exact?.onItems) {
    notes.push({ kind: "on-items", text: `'${exact.name.trim()}' is already on your items. Adding it gives it a card.` });
  }
  if (!exact) {
    // Same company, another spelling: against what the org has, then against rows ABOVE this one
    // in the file (the first spelling keeps its tick; the later one asks).
    const fuzzy = existing.find((e) => likelySame(name, e.name));
    if (fuzzy) {
      notes.push({ kind: "same-company", text: `You already have '${fuzzy.name.trim()}'. Same Company?` });
    } else {
      const idx = all.findIndex((r) => r.id === row.id);
      const above = all.slice(0, Math.max(0, idx)).find((r) => vendorKey(r.name) !== key && likelySame(name, r.name));
      if (above) notes.push({ kind: "same-company", text: `Looks like '${above.name.trim()}' above. Same Company?` });
    }
  }
  return notes;
}

/** A strong or likely match only: "Zephyr Labs, Inc." and "Zephyr Labs Inc". A "possible" (same initials,
 *  different first word) is exactly the case the matcher says only a person can judge, and on a
 *  list of subcontractors it would flag half the file. */
function likelySame(a: string, b: string): boolean {
  if (!vendorKey(a) || !vendorKey(b)) return false;
  const m = matchSupplierNames(a, b);
  return !!m && (m.confidence === "strong" || m.confidence === "likely");
}

/** A row that can't be added as it stands: its name is already a live card, or too long. */
export function isBlocked(notes: RowNote[]): boolean {
  return notes.some((n) => n.kind === "already" || n.kind === "too-long");
}

/**
 * The preview, fresh from the file. Exact repeats in the file collapse to their first row (and say
 * so); every row gets its guesses; the tick starts ON except where there is something to decide
 * (Same Company?) or nothing to add (Already Have, a name too long).
 */
export function buildPreview(raw: RawVendorRow[], existing: ExistingVendor[]): PreviewRow[] {
  const byKey = new Map<string, PreviewRow>();
  const order: PreviewRow[] = [];
  for (const r of raw) {
    const name = r.name.replace(/\s+/g, " ").trim();
    const key = vendorKey(name);
    if (!key) continue;
    const seen = byKey.get(key);
    if (seen) {
      seen.copies += 1;
      // A repeat can still carry what the first row lacked (a phone on the second line).
      for (const f of ["contact_name", "phone", "email", "website", "address"] as const) {
        if (!seen[f] && r[f]) seen[f] = r[f] ?? null;
      }
      continue;
    }
    const guess = guessKind(r.trade ? `${name} ${r.trade}` : name);
    const typedTrade = r.trade && r.trade.length <= 60 && !/^(brand|supplier|sub|subcontractor|vendor)s?$/i.test(r.trade) ? r.trade : null;
    const row: PreviewRow = {
      id: `line-${r.line}`,
      line: r.line,
      name,
      contact_name: r.contact_name ?? null,
      phone: r.phone ?? null,
      email: r.email ?? null,
      website: r.website ?? null,
      address: r.address ?? null,
      kind: guess.kind,
      trade: typedTrade ?? guess.trade,
      kindGuessed: true,
      is_person: guessPerson(name),
      copies: 1,
      ticked: true,
    };
    byKey.set(key, row);
    order.push(row);
  }
  for (const row of order) {
    const notes = notesFor(row, order, existing);
    row.ticked = !isBlocked(notes) && !notes.some((n) => n.kind === "same-company");
  }
  return order;
}

/** What Add sends: the ticked rows that can be added, as card fields. */
export function rowsToAdd(rows: PreviewRow[], existing: ExistingVendor[]): {
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  kind: VendorKind | null;
  trade: string | null;
  is_person: boolean;
  source_url: string | null;
  maps_url: string | null;
}[] {
  return rows
    .filter((r) => r.ticked && vendorKey(r.name) && !isBlocked(notesFor(r, rows, existing)))
    .map((r) => {
      // A pick's ticked fields replace what the row said; its source rides along only then.
      const found = applyPick({ phone: r.phone, email: r.email, website: r.website, address: r.address }, r.pick);
      return {
        name: r.name.trim(),
        contact_name: r.contact_name,
        phone: found.phone ?? null,
        email: found.email ?? null,
        website: found.website ?? null,
        address: found.address ?? null,
        kind: r.kind,
        trade: r.trade?.trim() || null,
        is_person: r.is_person,
        source_url: found.source_url,
        maps_url: found.maps_url,
      };
    });
}

/** "29 Names In Vendors.xlsx", with what was left out said too. */
export function previewHeading(count: number, fileName: string, headerSkipped: boolean, overCap: number): { title: string; detail: string | null } {
  const title = `${count} Name${count === 1 ? "" : "s"} In ${fileName}`;
  const bits: string[] = [];
  if (headerSkipped) bits.push("The heading row was left out.");
  if (overCap) bits.push(`Only the first ${IMPORT_MAX_ROWS} rows are shown; ${overCap} more were left out. Split the file to add them.`);
  return { title, detail: bits.length ? bits.join(" ") : null };
}
