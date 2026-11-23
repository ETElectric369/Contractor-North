/**
 * SEED A CLIENT COMPONENT'S STATE FOR A STATIC DRAW (cn-v1185). The unit project runs in plain Node
 * with no DOM, so a form's "after the tap" screens cannot be reached by tapping. A test mocks
 * `react` with `seededReact` and names, by call order within one draw, the useState slots it wants
 * to start somewhere else: `seed({ 10: true })` makes the eleventh useState of the next draw start
 * at `true`. Every other slot is React's own. react-dom keeps the real React (it is not mocked),
 * so the draw is the real renderer.
 *
 *   vi.mock("react", async (orig) => seededReact(await orig()));
 *   seed({ 10: true }); const html = renderToStaticMarkup(createElement(Form, props));
 */
// On globalThis, not module scope: the mock factory and the test may hold two copies of this file.
type Seat = { slots: Record<number, unknown>; calls: number };
const seat = (): Seat => ((globalThis as { __seedState?: Seat }).__seedState ??= { slots: {}, calls: 0 });

/** The slots the NEXT draw starts at; resets the call counter. */
export function seed(next: Record<number, unknown> = {}) {
  seat().slots = next;
  seat().calls = 0;
}

export function seededReact<T extends { useState: (...a: never[]) => unknown }>(real: T): T {
  const realUseState = real.useState as unknown as (init: unknown) => [unknown, (v: unknown) => void];
  return {
    ...real,
    useState: (init: unknown) => {
      const st = seat();
      const i = st.calls++;
      if (Object.prototype.hasOwnProperty.call(st.slots, i)) return [st.slots[i], () => {}];
      return realUseState(init);
    },
  } as T;
}
