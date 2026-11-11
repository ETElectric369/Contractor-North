/**
 * THE ESTIMATE'S CIRCUIT SCHEDULE CARD: WHEN IT IS DRAWN, AND WHEN IT CAN BE ASKED FOR (cn-v1160).
 *
 * The owner, 2026-11-10: "we do not need the circuit schedule on the estimates page, right now it
 * shows up on the bottom of every one". Until then the Panel Map switch alone drew the card, so every
 * saved estimate of an electrical company ended in an empty schedule.
 *
 * - `has`: the estimate holds at least one circuit row. Those rows are on the proposal the customer
 *   signs (the paper prints the rows that have words, a subset of these), so an estimate that has
 *   them always shows its card, whatever the switch says.
 * - `canAdd`: the one door to start a schedule on THIS estimate, a row in its ⋯ menu. Only with
 *   Panel Map on (the switch keeps its meaning: off, nothing is offered), only while there is nothing
 *   to show already, and never on a locked estimate, where nothing new could be written into it.
 *
 * Pure: the page asks it, the tests table it.
 */
export function circuitCard(input: { panelMapOn: boolean; circuits: unknown; locked: boolean }): { has: boolean; canAdd: boolean } {
  const has = Array.isArray(input.circuits) && input.circuits.length > 0;
  return { has, canAdd: input.panelMapOn && !has && !input.locked };
}
