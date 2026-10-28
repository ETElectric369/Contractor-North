/**
 * A VIEW of the trade package registry (lib/trade-package), kept under the names its importers know.
 *
 * Before cn-v1135 this file held its own ten job-code lists, and lib/trade-code-packs held five more
 * that disagreed with them (TRBL here, TROUB there). The registry is the home now: ONE list per trade,
 * one spelling, seeded whole at sign-up (create_organization's `p_codes`, migration 0078) and offered
 * by "Import A Trade's Codes" in Settings. Nothing here is a second copy; a row that changes changes
 * in the registry, and this view follows.
 *
 * IMPORT RULE: lib/features imports TRADE_ORDER from HERE at runtime, and the registry imports only a
 * type from lib/features — that is what keeps the three files free of a runtime cycle.
 */
import { TRADE_ORDER, TRADE_PACKAGES, type JobCodeSeed, type TradeKey } from "@/lib/trade-package";

export { TRADE_ORDER } from "@/lib/trade-package";
export type { JobCodeSeed } from "@/lib/trade-package";

/** The sign-up seed per trade: the registry's menu row and its whole code list, in TRADE_ORDER. */
export const TRADE_PRESETS: Record<TradeKey, { label: string; codes: JobCodeSeed[] }> = Object.fromEntries(
  TRADE_ORDER.map((k) => [k, { label: TRADE_PACKAGES[k].menu, codes: TRADE_PACKAGES[k].codes }]),
) as Record<TradeKey, { label: string; codes: JobCodeSeed[] }>;
