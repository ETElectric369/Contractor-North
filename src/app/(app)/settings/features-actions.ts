"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { dbError } from "@/lib/db-error";
import { isFeatureKey, normalizeFeatures, type FeatureKey } from "@/lib/features";
import { isTradeKey, tradePackage, type TradeKey } from "@/lib/trade-package";
import { orgTrade, tradeKeyFromWords } from "@/lib/org-trade";
import { codesAddedWords, switchesMovedWords, tradeOffersFor, type SwitchMove, type TradeOffers } from "@/lib/trade-offers";
import { importTradeCodePack } from "./actions";
import { createStarterInspectionSheet } from "../forms/actions";

export type SetFeatureResult =
  | { ok: true; key: FeatureKey; on: boolean; previous: boolean }
  | { ok: false; error: string };

/**
 * TURN ONE FEATURE ON OR OFF (the switch board, 0352). The owner only, and the database decides
 * that, not this file: set_org_feature checks the role of an active seat, takes the company from
 * the signed-in person, whitelists the key and writes the audit row. This file only says the
 * answer in plain words.
 *
 * NOTHING SILENT: the RPC hands back the value it stored, and anything but the asked-for value is
 * a failure, never a quiet success. `previous` comes back for Undo.
 */
export async function setFeature(key: FeatureKey, on: boolean): Promise<SetFeatureResult> {
  if (!isFeatureKey(key)) return { ok: false, error: "That isn't a feature." };
  if (typeof on !== "boolean") return { ok: false, error: "Say on or off." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_org_feature", { p_key: key, p_on: on });
  if (error) {
    // PGRST202: PostgREST has no such function (0352 not applied: a deploy can land before its
    // migration). 42883: Postgres says the same thing.
    if (error.code === "PGRST202" || error.code === "42883")
      return { ok: false, error: "Features need an update from North. Nothing changed." };
    return { ok: false, error: dbError(error) };
  }
  const back = (data ?? null) as { key?: unknown; on?: unknown; previous?: unknown } | null;
  if (back?.key !== key || back?.on !== on) return { ok: false, error: "That didn't save. Reload and try again." };
  // Every door in the shell reads the switches: the dock, the menus, the job tabs, Needs You.
  revalidatePath("/", "layout");
  return { ok: true, key, on, previous: back.previous !== false };
}

// ── YOUR TRADE & PRICING (cn-v1135): the owner's two doors on Settings › Features ───────────────

/** The words 0398's set_org_trade refuses a non-owner with; the app says the same before asking it. */
const OWNER_WORDS = "Only the owner can change the company's trade.";
/** The pricing door's own refusal (S5): it is not the trade door, so it does not borrow its words. */
const PRICING_WORDS = "Only the owner chooses how the company prices, on the Features page in Settings.";
const NOT_SAVED = "That didn't save. Reload and try again.";
const NEEDS_UPDATE = "Features need an update from North. Nothing changed.";

type Owner = { supabase: Awaited<ReturnType<typeof createClient>>; userId: string; orgId: string };

/**
 * The owner of an active seat, with their company. The database decides again on every write
 * (0398's set_org_trade checks the role; RLS scopes the settings reads and writes); this says no
 * in words before a read happens, the way setOfficeSeesOwnerMoney does, so a non-owner never sees
 * a developer error from a refused RPC or a zero-row update.
 */
async function requireOwner(refusal = OWNER_WORDS): Promise<Owner | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to your company first." };
  const { data: me } = await supabase.from("profiles").select("role, org_id, active").eq("id", user.id).maybeSingle();
  const row = me as { role?: string | null; org_id?: string | null; active?: boolean | null } | null;
  if (!row || row.active === false || !row.org_id) return { error: "Sign in to your company first." };
  if (row.role !== "owner") return { error: refusal };
  return { supabase, userId: user.id, orgId: row.org_id };
}

/** The company's stored settings, read by the owner's own client (RLS: their company). */
async function readSettings(o: Owner): Promise<{ settings: Record<string, unknown> } | { error: string }> {
  const { data, error } = await o.supabase.from("organizations").select("settings").eq("id", o.orgId).maybeSingle();
  if (error) return { error: dbError(error) };
  if (!data) return { error: NOT_SAVED };
  const raw = (data as { settings?: unknown }).settings;
  return { settings: raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {} };
}

/**
 * One settings write of the keys given, merged over the row as it stands, scoped to the company,
 * with the written row asked back: a zero-row UPDATE is a 204 and PostgREST calls it success (the
 * silent-write law), so the row is read back and a miss is said. The pins (0352, 0397) carry their
 * own keys through: nothing here can move a switch, the trade or the owner-only keys.
 */
async function writeSettings(o: Owner, patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const read = await readSettings(o);
  if ("error" in read) return { ok: false, error: read.error };
  const { data: wrote, error } = await o.supabase
    .from("organizations")
    .update({ settings: { ...read.settings, ...patch } })
    .eq("id", o.orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: NOT_SAVED };
  return { ok: true };
}

export type SetOrgTradeResult =
  | {
      ok: true;
      previous: TradeKey | "";
      trade: TradeKey | "";
      /** The company's own trade words, when they were cleared because they named another trade; null when kept. */
      clearedWords: string | null;
      /** What the new trade's package would add; null for Other, and null when that read failed (offersError says so). */
      offers: TradeOffers | null;
      offersError?: string;
    }
  | { ok: false; error: string };

/**
 * CHANGE THE COMPANY'S TRADE (0398 set_org_trade). The owner only; the database decides again.
 *
 * WHAT FOLLOWS THE KEY AT ONCE (the card says so, B1): every reader of the key flips on this save —
 * Nort's words (lib/trade-nort), the Tools page's packages, a new permit's default type, which
 * inspection starter is offered, and for a deck company pricing from its catalog the public
 * instant-estimate page, the site's estimate button, the sitemap entry and the site chat's deck tool
 * (lib/org-trade deckConfiguratorOn). What is WRITTEN is the key — and, by the label rule below, the
 * company's own words when they would contradict it. No code is seeded, no switch flips, no sheet
 * starts: what the new trade's package would add comes back as `offers`, each behind its own button
 * on the card, so the owner decides each one and sees what it did.
 *
 * THE LABEL RULE: the stored trade words (trade_label, the company's own: "handyman", "deck builder")
 * are what every prompt reads over the key (lib/org-trade orgTrade). When the words name a KNOWN
 * trade that is not the new key, they would keep telling Nort the old trade, so they are cleared and
 * the key's own words stand in — and the answer names what was cleared (`clearedWords`), never
 * silently. Words that read as no trade, or as the same trade, are kept: "handyman" stays right when
 * a company moves from Other to General contractor.
 */
export async function setOrgTrade(trade: string): Promise<SetOrgTradeResult> {
  const o = await requireOwner();
  if ("error" in o) return { ok: false, error: o.error };
  const picked = String(trade ?? "").trim();
  // "other" is the sign-up menu's word for Not Listed; the database stores no key for it.
  const p_trade = picked === "other" ? "" : picked;
  if (p_trade !== "" && !isTradeKey(p_trade)) return { ok: false, error: `There is no trade called "${picked}".` };

  const { data, error } = await o.supabase.rpc("set_org_trade", { p_trade });
  if (error) {
    // PGRST202 / 42883: 0398 is not on this database yet (a deploy can land before its migration).
    if (error.code === "PGRST202" || error.code === "42883") return { ok: false, error: NEEDS_UPDATE };
    return { ok: false, error: dbError(error) };
  }
  const back = (data ?? null) as { previous?: unknown; trade?: unknown } | null;
  const now = back?.trade === null || back?.trade === undefined ? "" : back.trade;
  if (!back || now !== p_trade) return { ok: false, error: NOT_SAVED };
  const previous = isTradeKey(back.previous) ? back.previous : "";
  // THE KEY HAS LANDED: every trade-shaped door reads it (the dock's calculators, Nort's words, a
  // permit's default), so the caches drop here, on every path from here — a failed label read or
  // offers read below still leaves the new trade live, and the screens must not show the old one.
  revalidatePath("/settings");
  revalidatePath("/", "layout");

  // The label rule, after the key landed. A failed read or write here is said, but the trade is
  // already the new one: the answer carries the key and says the words did not follow.
  // THE WORDS ARE READ THROUGH THE ONE READER (lib/org-trade orgTrade; org-trade.test holds every
  // read of the stored key to it): its label is the company's own words, or the key's own words
  // when none are stored — and the key's own words read as the key itself, so they are never
  // cleared. Only the clearing WRITE names the stored key, here.
  const read = await readSettings(o);
  if ("error" in read) return { ok: false, error: `Your trade is saved, but its words could not be checked: ${read.error}` };
  const words = orgTrade(read.settings).label;
  const wordsKey = tradeKeyFromWords(words);
  let clearedWords: string | null = null;
  if (wordsKey && wordsKey !== p_trade) {
    const cleared = await writeSettings(o, { trade_label: "" });
    if (!cleared.ok) return { ok: false, error: `Your trade is saved, but its old words ("${words}") could not be cleared: ${cleared.error}` };
    clearedWords = words;
  }

  // The offers are a READ after the trade landed: a failed one is said beside the landed trade,
  // never as a refusal of the save that already happened (S1: the card would otherwise show a
  // refusal for a trade that had moved).
  const landed = p_trade as TradeKey | "";
  if (!p_trade) return { ok: true, previous, trade: landed, clearedWords, offers: null };
  try {
    return { ok: true, previous, trade: landed, clearedWords, offers: await offersFor(o, p_trade, read.settings) };
  } catch {
    return { ok: true, previous, trade: landed, clearedWords, offers: null, offersError: "Couldn't read what to offer — reload to see the buttons." };
  }
}

/** The diff for one trade against what the company holds (its codes, its switches, its sheet). */
async function offersFor(o: Owner, key: TradeKey, settings: Record<string, unknown>): Promise<TradeOffers> {
  const [codes, sheet] = await Promise.all([
    o.supabase.from("job_codes").select("code").eq("org_id", o.orgId),
    o.supabase.from("forms").select("id").eq("org_id", o.orgId).eq("is_inspection", true).limit(1).maybeSingle(),
  ]);
  if (codes.error) throw new Error(dbError(codes.error));
  if (sheet.error) throw new Error(dbError(sheet.error));
  return tradeOffersFor(key, {
    codes: ((codes.data ?? []) as { code: unknown }[]).map((r) => String(r.code ?? "")),
    features: normalizeFeatures(settings.features, settings.timeclock_job_codes),
    hasSheet: !!sheet.data,
  });
}

export type TradeDoorResult = { ok: true; words: string } | { ok: false; error: string };

/**
 * ADD THE TRADE'S JOB CODES the company lacks (the same import as Settings › Scheduling › Import A
 * Trade's Codes: a code the company has under either spelling is skipped, nothing is renamed or
 * removed). Says how many landed.
 */
export async function applyTradeCodes(trade: string): Promise<TradeDoorResult> {
  const o = await requireOwner();
  if ("error" in o) return { ok: false, error: o.error };
  const pkg = tradePackage(trade);
  if (!pkg) return { ok: false, error: `There is no trade called "${String(trade ?? "")}".` };
  const res = await importTradeCodePack(pkg.key);
  if (!res.ok) return { ok: false, error: res.error ?? NOT_SAVED };
  revalidatePath("/settings");
  return { ok: true, words: codesAddedWords(pkg.menu, res.added ?? 0, res.skipped ?? 0) };
}

export type TradeSwitchesResult = { ok: true; moved: SwitchMove[]; words: string } | { ok: false; error: string; moved: SwitchMove[] };

/**
 * USE THE TRADE'S USUAL SWITCHES: one set_org_feature per key the package names whose value differs
 * from the company's today (the diff is read fresh, so a switch the owner moved meanwhile is not
 * moved back). Each flip is its own audit row, as on the board. A refusal stops the run and says
 * what had already moved, so nothing is half-said.
 */
export async function applyTradeSwitches(trade: string): Promise<TradeSwitchesResult> {
  const o = await requireOwner();
  if ("error" in o) return { ok: false, error: o.error, moved: [] };
  if (!isTradeKey(trade)) return { ok: false, error: `There is no trade called "${String(trade ?? "")}".`, moved: [] };
  const read = await readSettings(o);
  if ("error" in read) return { ok: false, error: read.error, moved: [] };
  let offers: TradeOffers;
  try {
    offers = await offersFor(o, trade, read.settings);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), moved: [] };
  }
  const moved: SwitchMove[] = [];
  for (const s of offers.switches) {
    const res = await setFeature(s.key, s.on);
    if (!res.ok) {
      const sofar = moved.length ? ` ${switchesMovedWords(moved)}` : "";
      return { ok: false, error: `${s.words} didn't land: ${res.error}${sofar}`, moved };
    }
    moved.push(s);
  }
  revalidatePath("/settings");
  return { ok: true, moved, words: switchesMovedWords(moved) };
}

/**
 * START THE TRADE'S INSPECTION SHEET: the starter for the company's stored trade (forms/actions
 * createStarterInspectionSheet reads the key through orgTrade, so it is the trade just saved). A
 * sheet that already exists is the company's own and stays; that is said, nothing is made.
 */
export async function startTradeSheet(trade: string): Promise<TradeDoorResult> {
  const o = await requireOwner();
  if ("error" in o) return { ok: false, error: o.error };
  const pkg = tradePackage(trade);
  if (!pkg) return { ok: false, error: `There is no trade called "${String(trade ?? "")}".` };
  const { data: existing, error: readErr } = await o.supabase
    .from("forms")
    .select("id")
    .eq("org_id", o.orgId)
    .eq("is_inspection", true)
    .limit(1)
    .maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  if (existing) return { ok: true, words: "You already have an inspection sheet; it stays." };
  const res = await createStarterInspectionSheet();
  if (!res.ok) return { ok: false, error: res.error ?? NOT_SAVED };
  revalidatePath("/settings");
  return { ok: true, words: `Started ${pkg.menu}'s inspection sheet. Edit it under Settings › Inspection Sheet.` };
}

export type SetEstimatingModeResult = { ok: true; mode: "research" | "catalog" } | { ok: false; error: string };

/**
 * HOW THE COMPANY PRICES (settings.estimating_mode): research = the price book first, current prices
 * researched for what it lacks, sizes calculated; catalog = only the company's own price list and
 * kits, never a web price (and the public configurator for a deck builder: lib/org-trade
 * deckConfiguratorOn). The owner's door, written with the owner's own client and the row asked
 * back — never through updateOrgSettings' staff path, which strips the key (settings/actions
 * PROTECTED_SETTINGS_KEYS). A non-owner is refused in this door's own words, not the trade door's.
 */
export async function setEstimatingMode(mode: string): Promise<SetEstimatingModeResult> {
  const o = await requireOwner(PRICING_WORDS);
  if ("error" in o) return { ok: false, error: o.error };
  if (mode !== "research" && mode !== "catalog") return { ok: false, error: "Say research or catalog." };
  const wrote = await writeSettings(o, { estimating_mode: mode });
  if (!wrote.ok) return { ok: false, error: wrote.error };
  // The estimator, Nort, the site chat and the public configurator all read the mode.
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true, mode };
}
