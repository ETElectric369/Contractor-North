/**
 * THE ?new=1 CLAIM. A page can mount the same "new X" button more than once (the header and the
 * empty state), and only one of them may answer the quick-add menu's ?new=1 or two modals stack.
 *
 * It used to be a module-level boolean that the claimer set and ANY instance cleared on seeing
 * the param gone. When the strip (router.replace) died on a dropped connection the param never
 * went, the claimer unmounted still holding the flag, and every later + → New X landed on the
 * page with no form, on good signal too, until something mounted the button without ?new
 * (sweep f28d8de3). So the claim names its holder: the holder lets go when the param goes AND
 * when it unmounts, and nobody else can let go for it. The second rule matters on the empty
 * state: that copy unmounts the moment the first record exists, and it must not free a claim
 * the header copy still holds.
 */
export function createParamClaim() {
  let holder: string | null = null;
  return {
    /** True when `id` just took the claim, i.e. it was free: this instance answers the param. */
    take(id: string): boolean {
      if (holder !== null) return false;
      holder = id;
      return true;
    },
    /** Let go, but only if `id` is the one holding it. */
    release(id: string): void {
      if (holder === id) holder = null;
    },
  };
}
