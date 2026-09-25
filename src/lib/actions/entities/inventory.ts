import type { ActionDef } from "../types";

/**
 * THE SHELF'S ACTIONS. Empty for now, on purpose (Shop Stock, 0303).
 *
 * inventory.adjust typed a signed delta over quantity_on_hand. That column is a cache the shelf's
 * own record keeps now and the database refuses a typed count, so the action could only ever fail.
 * It is retired rather than left as a door that says no. Nort's way to move stock comes back as
 * stock.take (Phase 3): it FILLS the Took From Stock card and a person taps Take It.
 */
export const inventoryActions: Record<string, ActionDef> = {};
