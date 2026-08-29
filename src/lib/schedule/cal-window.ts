/**
 * THE CALENDAR'S DATA WINDOW — one pair of numbers, shared by the fetch and every consumer.
 *
 * CalendarPanel preloads this span around "now" and paging never refetches, so anything allowed
 * to navigate past it renders real-looking days that are silently EMPTY — "nothing scheduled"
 * where the truth is "nothing loaded". The scroll stacks, the chevrons, and the ?date= anchor all
 * clamp against these same constants (hand-copied-list law: the caps used to be four literals in
 * two files held in sync by a comment).
 */
export const CAL_WINDOW_BACK_DAYS = 120;
export const CAL_WINDOW_FWD_DAYS = 400;
