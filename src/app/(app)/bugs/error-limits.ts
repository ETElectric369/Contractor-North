/**
 * THE LIST'S SHAPE, in a plain module: a "use server" file may export only async functions (the
 * build refuses a constant there — the first cn-v1136 deploy died on exactly this), so the limits,
 * the filter and the label that the actions and their tests share live here.
 */
/** PostgREST's row cap: the open read asks for exactly this many, and when exactly this many come
 *  back the page says the list may be cut. */
export const OPEN_ERRORS_LIMIT = 1000;
/** The closed-and-trace read: the newest 300 by last sighting, as the whole list used to be. */
export const REST_ERRORS_LIMIT = 300;
/** The rest, as PostgREST's `or` filter spells it: closed rows (fixed, ignored) or trace rows of any status. */
export const REST_ERRORS_FILTER = "status.in.(fixed,ignored),level.eq.trace";
/** The company's name when platform_org_label could not answer (N4): said, never a silent null. */
export const UNKNOWN_COMPANY = "Unknown Company";
