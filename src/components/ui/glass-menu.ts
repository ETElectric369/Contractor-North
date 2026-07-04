/**
 * THE glass dropdown-menu chrome — the chamfered sea-glass panel that every ⋯ / account /
 * quick-add menu floats in. One definition of the z / overflow / radius / padding / shadow
 * recipe so the five menus that hand-rolled the identical string can't drift. Compose with
 * the per-menu width + positioning at the call site:
 *   className={`${GLASS_MENU_CLASS} w-56`}   style={{ position: "absolute", right: 0, … }}
 * (The `.glass-menu` base + `.glass`/`.glass-gloss` skins live in globals.css.)
 */
export const GLASS_MENU_CLASS =
  "glass glass-gloss glass-menu z-[90] overflow-hidden rounded-lg py-1.5 shadow-xl";
