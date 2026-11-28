import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NEXT'S ROUTER QUEUE, RUN — the rule a page leans on when the record under it is deleted.
 *
 * Erik, 2026-11-10: "i deleted a couple inspections and instead of going back to the inspection page
 * it goes to" the app's 404. A delete's server action revalidates, so Next renders the page it was
 * sent from into the action's own answer; that page's row is gone, it answers notFound(), and the
 * root 404 replaces the whole shell. Whether that render is ever APPLIED is decided by Next's action
 * queue, and this file runs that queue: the installed build's own dispatchAction, runAction and
 * runRemainingActions, with only the reducer stood in for (no network, no DOM, no React tree).
 *
 *   1. The caller hears the answer while the action is still on the queue.
 *   2. A navigation or a Back dispatched then TAKES ITS PLACE: the action's state is never applied,
 *      and the queue owes a refresh to wherever it ends up, IF the action revalidated (since Next
 *      16; Next 15 owed it for every discarded action). The reducer marks the action as one that
 *      revalidated before it answers the caller, so the mark is there when the queue looks.
 *   3. A Back that lands while a navigation is in flight takes THAT one's place too.
 *
 * (2) is the fix: the visit's doors navigate in the tick the answer arrives, so the dead page is
 * thrown away (src/app/(app)/appointments/visit-leaves-home.test.tsx pins the doors). (2) and (3)
 * together were the bug: Edit Details' Delete closed its sheet and then pushed; the sheet's closing
 * history step reached the router as a Back, displaced the push, and the owed refresh asked for the
 * visit that had just been deleted. And the old Won't Happen went router.back(), which dispatches
 * nothing in that tick, so the dead page WAS applied and the Back had to race it.
 *
 * A TRIPWIRE ON PURPOSE. It reads Next's internals; a Next upgrade that moves them fails here, and
 * that is the moment to check a visit's delete doors (and every await-then-navigate delete in the
 * app) by hand before re-pinning.
 *
 * RE-PINNED FOR NEXT 16.4.6 (cn-v1214, 2026-11-27), AFTER THAT CHECK. The doors were driven in a real
 * browser engine on 15.5.29 and on 16.4.6, the same source built twice with the app's own Modal:
 * a delete that navigates in the tick never shows the 404 on either, in a sheet or out of one, with
 * fast pages and with slow ones. What changed in 16, and is pinned below as it is now:
 *   · the queue runs the reducer directly (15 wrapped it in an async function), and the reducer
 *     answers the caller with no await before it; the caller is still heard first;
 *   · the refresh after a discarded action is owed only when that action revalidated, and in the
 *     engine it is really sent now: the page a door lands on is asked for twice (15 sent it once);
 *   · once the queue drains after a navigation took an action's place, the queue publishes its own
 *     state once more, so a state can be handed to React twice;
 *   · the old close-then-push shape no longer ends on the 404: the owed refresh is requested and
 *     its answer is never drawn, so the page of the deleted record stays on screen. Still a door
 *     that must not be written.
 */
type Action = { type: string; url?: string; didRevalidate?: boolean; resolve?: (v: unknown) => void; reject?: (e: unknown) => void };
type State = { name: string };
type Queue = {
  state: State;
  pending: null | { payload: Action };
  last: unknown;
  needsRefresh?: boolean;
  action: (state: State, action: Action) => Promise<State> | State;
  dispatch: (payload: Action, setState: (s: State | Promise<State>) => void) => void;
};

const NEXT = join(process.cwd(), "node_modules/next/dist/client/components");
const nodeRequire = createRequire(import.meta.url);
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = loader._load;
const hadWindow = "window" in globalThis;

let types: Record<string, string>;
let queue: Queue;
const VISIT: State = { name: "the visit's page" };
const DEAD = "the visit's page, rendered again: notFound()";

beforeAll(() => {
  // Next resolves this one through its own bundler alias; nothing here decodes a server response.
  loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request.startsWith("react-server-dom-webpack")) return {};
    return realLoad.call(this, request, ...rest);
  };
  types = nodeRequire(join(NEXT, "router-reducer/router-reducer-types.js"));
  queue = nodeRequire(join(NEXT, "app-router-instance.js")).createMutableActionQueue(VISIT, null);
  // The browser, only once the modules have loaded (they wire listeners at load when a window exists).
  if (!hadWindow) (globalThis as { window?: unknown }).window = { location: { origin: "http://app.test" } };
});

afterAll(() => {
  loader._load = realLoad;
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * One door, played through the real queue. `inTheTick` is what the door does the moment its awaited
 * action answers; `later` is what arrives afterwards (a popstate, a fetch coming back). The stand-in
 * reducer keeps the real server-action reducer's promise shape (pinned at the bottom of this file):
 * fetchServerAction(...).then(async () => { mark the action as one that revalidated; resolve(result);
 * return state }), with no await before the caller is answered. `revalidated` is what the server's
 * answer said: every delete door's action revalidates, so it is true unless a test says otherwise.
 */
async function play(
  inTheTick: (q: Queue, set: (s: State | Promise<State>) => void) => void,
  later?: (q: Queue, set: (s: State | Promise<State>) => void, land: () => void) => Promise<void> | void,
  revalidated = true,
) {
  const applied: string[] = [];
  const heard: string[] = [];
  const set = (s: State | Promise<State>) => {
    if (s && typeof (s as Promise<State>).then === "function") void (s as Promise<State>).then((v) => applied.push(v.name), () => {});
    else applied.push((s as State).name);
  };
  let answer = () => {};
  let land = () => {};
  queue.state = VISIT;
  queue.pending = null;
  queue.last = null;
  queue.needsRefresh = false;
  const reduce = (state: State, action: Action): Promise<State> | State => {
    if (action.type === types.ACTION_SERVER_ACTION) {
      return new Promise<void>((r) => (answer = r)).then(async () => {
        if (revalidated) action.didRevalidate = true;
        action.resolve?.("deleted");
        return { name: DEAD };
      });
    }
    if (action.type === types.ACTION_NAVIGATE) return new Promise<void>((r) => (land = r)).then(() => ({ name: `navigated to ${action.url}` }));
    if (action.type === types.ACTION_RESTORE) return { name: `back on ${action.url}` };
    if (action.type === types.ACTION_REFRESH) return { name: `refresh of: ${state.name}` };
    return state;
  };
  // As createMutableActionQueue wires it since Next 16: the reducer itself, with no async wrapper around it.
  queue.action = reduce;
  // Next's callServer, in shape: an async function that returns a new Promise the reducer resolves.
  const callServer = async () => new Promise((resolve, reject) => queue.dispatch({ type: types.ACTION_SERVER_ACTION, resolve, reject }, set));
  const door = (async () => {
    await callServer(); // const res = await wontHappenAppointment(id)
    heard.push(queue.pending ? queue.pending.payload.type : "nothing pending");
    inTheTick(queue, set);
  })();
  await tick();
  answer();
  await door;
  await tick();
  await later?.(queue, set, () => land());
  await tick();
  return { applied, heard, endsOn: queue.state.name };
}

const navigate = (url: string) => (q: Queue, set: (s: State | Promise<State>) => void) => q.dispatch({ type: types.ACTION_NAVIGATE, url }, set);
const back = (url: string) => (q: Queue, set: (s: State | Promise<State>) => void) => q.dispatch({ type: types.ACTION_RESTORE, url }, set);

describe("next's action queue, as installed: a navigation or a Back takes a pending action's place", () => {
  it("the door hears the answer while its action is still the one on the queue", async () => {
    const r = await play(() => {});
    expect(r.heard).toEqual([types.ACTION_SERVER_ACTION]);
    // And with nothing dispatched in that tick, the action's own re-render of the page is applied.
    expect(r.applied).toEqual([DEAD]);
  });

  it("the old ⋯ › Won't Happen (router.back): the dead page is applied first, and the Back has to undo it", async () => {
    const r = await play(
      () => {}, // window.history.back(): the browser's, nothing on the queue
      (q, set) => back("/inspections")(q, set), // its popstate, a moment later
    );
    expect(r.applied).toEqual([DEAD, "back on /inspections"]);
  });

  it("the doors now: a navigation in the tick the answer arrives, and the dead page is never applied", async () => {
    const r = await play(navigate("/inspections"), (_q, _set, land) => land());
    // The queue's own publish once it drains, the owed refresh, then the navigation's own promise.
    expect(r.applied).toEqual(["navigated to /inspections", "refresh of: navigated to /inspections", "navigated to /inspections"]);
    expect(r.applied).not.toContain(DEAD);
    expect(r.endsOn).toBe("refresh of: navigated to /inspections");
  });

  it("the same door after an action that revalidated nothing: the dead page is still thrown away, and no refresh is owed", async () => {
    const r = await play(navigate("/inspections"), (_q, _set, land) => land(), false);
    expect(r.applied).toEqual(["navigated to /inspections", "navigated to /inspections"]);
    expect(r.applied).not.toContain(DEAD);
    expect(r.endsOn).toBe("navigated to /inspections");
  });

  it("the old Edit Details › Delete (close, then push): the sheet's Back displaces the push, and the owed refresh asks for the deleted visit", async () => {
    const r = await play(navigate("/schedule?view=day"), async (q, set, land) => {
      back("/appointments/abc123")(q, set); // the closing Modal's history step, while the push is in flight
      await tick();
      land(); // the push's page comes back, too late: it was discarded
    });
    expect(r.applied).toEqual(["back on /appointments/abc123", "back on /appointments/abc123", "refresh of: back on /appointments/abc123"]);
    expect(r.applied.some((s) => s.startsWith("navigated"))).toBe(false);
    expect(r.endsOn).toBe("refresh of: back on /appointments/abc123");
  });

  it("the stand-in reducer keeps the real one's shape: the caller is answered before the reducer returns its state", () => {
    const reducer = readFileSync(join(NEXT, "router-reducer/reducers/server-action-reducer.js"), "utf8");
    expect(reducer).toMatch(/return fetchServerAction\(state, nextUrl, action\)\.then\(async \(\{ revalidationKind, actionResult, /);
    // The action is marked as one that revalidated BEFORE the caller is answered, and nothing is
    // awaited in between: no `await` stands anywhere between the two lines.
    const from = reducer.indexOf("return fetchServerAction(state, nextUrl, action).then(async (");
    const marked = reducer.indexOf("action.didRevalidate = true;", from);
    const answered = reducer.search(/\} else \{\s*\/\/ If there's no redirect, resolve the action with the result\.\s*resolve\(actionResult\);/);
    expect(from).toBeGreaterThan(-1);
    expect(marked).toBeGreaterThan(from);
    expect(answered).toBeGreaterThan(marked);
    expect(reducer.slice(from, answered)).not.toMatch(/\bawait\b/);
    // The queue runs the reducer itself, as the stand-in above is wired, and owes the refresh only
    // for a discarded server action that revalidated.
    const instance = readFileSync(join(NEXT, "app-router-instance.js"), "utf8");
    expect(instance).toMatch(/action: _routerreducer\.reducer,/);
    expect(instance).toMatch(/if \(action\.payload\.type === _routerreducertypes\.ACTION_SERVER_ACTION && action\.payload\.didRevalidate\) \{[\s\S]{0,260}?actionQueue\.needsRefresh = true;/);
    expect(instance).toMatch(/actionQueue\.pending\.discarded = true;\s*actionQueue\.wasPreempted = true;/);
  });
});
