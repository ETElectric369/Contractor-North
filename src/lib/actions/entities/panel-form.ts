/**
 * WHERE A SPOKEN CIRCUIT GOES ON THE DOOR (the panel-first wave). Pure: no database, no React.
 *
 * Nort hears "put Bar and Mini Fridge on 17 as a tandem 20/20" and "Mini Split on 9 and 11, 2-pole
 * 30". The model hands panel.suggest one object per circuit with what was SAID about its place: the
 * space, the spaces ("9 and 11"), the half (A or B), the poles, and the FORM — single, tandem,
 * 2-pole or 3-pole. This file turns those words into the three columns a circuit keeps (space, half,
 * poles), the way the Panel tab keeps them:
 *
 *   single   one pole, the whole space (no half).
 *   tandem   one pole, HALF a space: two tandems said on one space are its two halves, A (the top)
 *            then B, in the order said, unless a half was said. One tandem said alone on a space with
 *            no half is a hole, and a hole ASKS (Erik's law): which half, A on top or B below?
 *   2-pole   two poles: the space and the one two below it on the same side ("9 and 11" is space 9).
 *   3-pole   three poles: three spaces, two apart.
 *   quad     four handles on two spaces, s and s+2 (a Siemens quad): its two outer singles and its
 *            centre 2-pole, each said as its own circuit on the quad's space. Where its handles hang
 *            is the model's one rule (quadCentreHalf, quadOuterSlots), and it depends on which way
 *            the panel's numbers run: space 1 at the top, the centre is sB (sB and (s+2)A) and the
 *            singles sA then (s+2)B; space 1 at the bottom, the centre is sA (sA and (s+2)B) and the
 *            singles (s+2)A then sB. The first single said is the top one.
 *
 * Words that disagree (a tandem said with 2 poles, "9 and 10" for a 2-pole, a single with a half)
 * are refused in plain words, never quietly settled one way. A hole ASKS: a tandem (or a half) with
 * no space, a lone tandem with no half, a quad on a job whose panel can't be told. The words stay
 * English: the form words have no Spanish key in the catalogs (the Panel tab is English-only), and
 * Nort maps what it hears in either language onto these five.
 */
import type { PanelNumbering } from "@/lib/types";
import { quadCentreHalf, quadOuterSlots } from "@/lib/panel/model";

export const CIRCUIT_FORMS = ["single", "tandem", "2-pole", "3-pole", "quad"] as const;
export type CircuitForm = (typeof CIRCUIT_FORMS)[number];

/** What one circuit's words said about where it goes. */
export type SaidPlace = {
  space?: number | null;
  spaces?: number[] | null;
  half?: "A" | "B" | null;
  poles?: number | null;
  form?: CircuitForm | null;
};

/** Where it goes, as the Panel tab keeps it. */
export type Place = { space: number | null; half: "A" | "B" | null; poles: number };

/** The poles a form says (a quad's circuits are singles and a 2-pole, so it says none). */
const FORM_POLES: Record<CircuitForm, number | null> = { single: 1, tandem: 1, "2-pole": 2, "3-pole": 3, quad: null };
const FORM_WORDS: Record<CircuitForm, string> = { single: "a single", tandem: "a tandem", "2-pole": "a 2-pole", "3-pole": "a 3-pole", quad: "part of a quad" };

/**
 * `numbering` is the panel's (which way its numbers run): only a quad needs it, and null (the job
 * has several panels, so which one is unknown) makes a quad a question. Unsaid is unknown.
 */
export function placeSaid(said: SaidPlace[], opts: { numbering?: PanelNumbering | null } = {}): { ok: true; value: Place[] } | { ok: false; error: string } {
  const out: (Place & { tandem: boolean; quad: boolean })[] = [];
  for (const [i, s] of said.entries()) {
    const n = `Circuit ${i + 1}`;
    const form = s.form ?? null;
    const formPoles = form ? FORM_POLES[form] : null;
    const poles = s.poles ?? null;
    if (formPoles != null && poles != null && formPoles !== poles) {
      return { ok: false, error: `${n}: it was said as ${FORM_WORDS[form!]} but with ${poles} pole${poles === 1 ? "" : "s"}. Which is it?` };
    }
    const quad = form === "quad";

    let space = s.space ?? null;
    let fromSpaces: number | null = null;
    const spaces = [...new Set((s.spaces ?? []).filter((x) => Number.isInteger(x)))].sort((a, b) => a - b);
    if (spaces.length) {
      for (let k = 1; k < spaces.length; k++) {
        if (spaces[k] - spaces[k - 1] !== 2) {
          return {
            ok: false,
            error: `${n}: spaces ${spaces.join(" and ")} aren't one breaker. A 2-pole takes a space and the one two below it on the same side, like 9 and 11.`,
          };
        }
      }
      if (space != null && space !== spaces[0]) {
        return { ok: false, error: `${n}: space ${space} and spaces ${spaces.join(" and ")} don't agree. Which space is it on?` };
      }
      space = spaces[0];
      fromSpaces = spaces.length;
      // A quad's spaces are the quad's two (s and s+2), not one breaker's poles.
      if (quad && fromSpaces > 2) return { ok: false, error: `${n}: a quad takes two spaces, like 1 and 3. Which two?` };
      const said = poles ?? formPoles;
      if (!quad && said != null && said !== fromSpaces) {
        return { ok: false, error: `${n}: ${spaces.join(" and ")} is ${fromSpaces} space${fromSpaces === 1 ? "" : "s"}, but it was said as ${said} pole${said === 1 ? "" : "s"}. Which is it?` };
      }
    }

    const p = quad ? (poles ?? 1) : (poles ?? formPoles ?? fromSpaces ?? 1);
    const half = s.half ?? null;
    if (half && form === "single") {
      return { ok: false, error: `${n}: a single takes the whole space, so it has no half. Say tandem for half a space.` };
    }
    if (half && p === 3) return { ok: false, error: `${n}: a 3-pole takes whole spaces; it has no half.` };
    if (quad && p === 3) return { ok: false, error: `${n}: a quad holds 1-poles and a 2-pole, not a 3-pole.` };
    if (quad && half) return { ok: false, error: `${n}: a quad's handles hang where the quad puts them. Say it without a half, or say it as a tandem.` };
    // A HOLE ASKS: half a space, with no space, is nowhere yet (never filed as a plain single).
    if (space == null && (form === "tandem" || quad || half)) {
      return { ok: false, error: `${n}: which space is the ${quad ? "quad" : form === "tandem" || p === 1 ? "tandem" : `${p}-pole`} on?` };
    }
    out.push({ space, half: space != null ? half : null, poles: p, tandem: form === "tandem", quad });
  }

  // A QUAD, said as its circuits on its first space: the 2-pole is the centre, the singles the outer
  // handles, the first said on top (the model's one rule, which way the panel's numbers run).
  const quads = new Map<number, number[]>();
  for (const [i, o] of out.entries()) if (o.quad && o.space != null) quads.set(o.space, [...(quads.get(o.space) ?? []), i]);
  for (const [space, idx] of quads) {
    if (opts.numbering == null) {
      return { ok: false, error: `Which panel is the quad on ${space} in? Its handles hang one way when space 1 is at the top and the other when it is at the bottom.` };
    }
    const centres = idx.filter((i) => out[i].poles === 2);
    const singles = idx.filter((i) => out[i].poles === 1);
    if (!centres.length && singles.length === 3) {
      return { ok: false, error: `The quad on ${space}: which one is the centre 2-pole?` };
    }
    if (centres.length > 1 || singles.length > 2) {
      return { ok: false, error: `A quad on ${space} is two outer singles and one centre 2-pole; ${idx.length} circuits were said on it.` };
    }
    for (const c of centres) out[c].half = quadCentreHalf(opts.numbering);
    const outer = quadOuterSlots(space, opts.numbering);
    singles.forEach((i, k) => {
      out[i].space = outer[k].space;
      out[i].half = outer[k].half;
    });
  }

  // A tandem said with its space and no half takes a half of that space nobody else in this ask
  // has: A, then B, in the order said.
  const bySpace = new Map<number, number[]>();
  for (const [i, o] of out.entries()) {
    if (o.quad || o.space == null || !(o.tandem || o.half)) continue;
    const at = bySpace.get(o.space) ?? [];
    at.push(i);
    bySpace.set(o.space, at);
  }
  for (const [space, idx] of bySpace) {
    for (const h of ["A", "B"] as const) {
      const on = idx.filter((i) => out[i].half === h);
      if (on.length > 1) return { ok: false, error: `Circuits ${on.map((i) => i + 1).join(" and ")} were both said on ${space}${h}. Which goes on the other half?` };
    }
    const taken = new Set(idx.map((i) => out[i].half).filter(Boolean));
    const open = (["A", "B"] as const).filter((h) => !taken.has(h));
    const need = idx.filter((i) => !out[i].half);
    if (!need.length) continue;
    if (idx.length > 2 || need.length > open.length) {
      return { ok: false, error: `Space ${space} holds two halves, A and B; ${idx.length} circuits were said on it as tandems.` };
    }
    if (idx.length === 1) {
      return { ok: false, error: `Circuit ${need[0] + 1}: which half of space ${space} is it, A (the top) or B (below)?` };
    }
    need.forEach((i, k) => (out[i].half = open[k]));
  }
  return { ok: true, value: out.map(({ space, half, poles }) => ({ space, half, poles })) };
}
