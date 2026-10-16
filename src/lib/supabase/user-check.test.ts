/**
 * A FAILED SIGN-IN CHECK IS NOT A SIGN-OUT (field feedback 2026-10-16: twice in one night the app
 * came back from the lock screen or a relaunch, getUser came back empty for a moment, and the
 * layout sent Erik to the login screen mid-conversation; once he re-typed his password). The check
 * tells a person, nobody, a refused session and no answer apart, looks once more after a blip, and
 * the layout and the middleware act on the answer, never on an empty hand.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, AuthUnknownError } from "@supabase/supabase-js";
import { checkUser, transientAuthError } from "./user-check";

const read = (p: string) => readFileSync(p, "utf8");
const person = { id: "u1" } as unknown as import("@supabase/supabase-js").User;
const answer = (user: unknown, error: unknown = null) => ({ data: { user }, error });
function fake(...answers: ReturnType<typeof answer>[]) {
  const getUser = vi.fn();
  for (const a of answers) getUser.mockResolvedValueOnce(a);
  return { sb: { auth: { getUser } } as unknown as Parameters<typeof checkUser>[0], getUser };
}
const fast = { retryMs: 0 };
const blip = () => new AuthRetryableFetchError("fetch failed", 0);

describe("checkUser tells the four answers apart", () => {
  it("a person: ok on the first look", async () => {
    const { sb, getUser } = fake(answer(person));
    expect(await checkUser(sb, fast)).toEqual({ user: person, reason: "ok", failed: false, error: null });
    expect(getUser).toHaveBeenCalledTimes(1);
  });
  it("nobody (no session, or no error at all): none, no second look, nothing to report", async () => {
    const { sb, getUser } = fake(answer(null, new AuthSessionMissingError()));
    expect(await checkUser(sb, fast)).toEqual({ user: null, reason: "none", failed: false, error: null });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(await checkUser(fake(answer(null)).sb, fast)).toMatchObject({ reason: "none", failed: false });
  });
  it("a refused session (401 / 403): a real sign-out, no second look, the error kept for the report", async () => {
    const err = new AuthApiError("invalid JWT", 401, "bad_jwt");
    const { sb, getUser } = fake(answer(null, err));
    expect(await checkUser(sb, fast)).toEqual({ user: null, reason: "refused", failed: false, error: err });
    expect(getUser).toHaveBeenCalledTimes(1);
  });
  it("a blip then a person: ok on the second look", async () => {
    const { sb, getUser } = fake(answer(null, blip()), answer(person));
    expect(await checkUser(sb, fast)).toMatchObject({ user: person, reason: "ok" });
    expect(getUser).toHaveBeenCalledTimes(2);
  });
  it("two blips: failed, with the last error — never a sign-out", async () => {
    const second = new AuthApiError("upstream", 503, "unexpected_failure");
    const { sb, getUser } = fake(answer(null, blip()), answer(null, second));
    expect(await checkUser(sb, fast)).toEqual({ user: null, reason: "failed", failed: true, error: second });
    expect(getUser).toHaveBeenCalledTimes(2);
  });
  it("a blip, then 'no session': still the blip (auth-js drops its copy of the session on a failed refresh)", async () => {
    const first = new AuthApiError("upstream", 500, "unexpected_failure");
    const { sb } = fake(answer(null, first), answer(null, new AuthSessionMissingError()));
    expect(await checkUser(sb, fast)).toEqual({ user: null, reason: "failed", failed: true, error: expect.objectContaining({ name: "AuthSessionMissingError" }) });
    const { sb: sb2 } = fake(answer(null, first), answer(null));
    expect(await checkUser(sb2, fast)).toMatchObject({ reason: "failed", error: first });
  });
  it("a blip, then a refusal: refused", async () => {
    const refusal = new AuthApiError("invalid JWT", 401, "bad_jwt");
    expect(await checkUser(fake(answer(null, blip()), answer(null, refusal)).sb, fast)).toEqual({ user: null, reason: "refused", failed: false, error: refusal });
  });
  it("a slow first look is not looked at again (auth-js already retried for ~25 s): failed at once", async () => {
    const getUser = vi.fn(async () => { await new Promise((r) => setTimeout(r, 60)); return answer(null, blip()); });
    const sb = { auth: { getUser } } as unknown as Parameters<typeof checkUser>[0];
    expect(await checkUser(sb, { retryMs: 0, retryOnlyUnderMs: 20 })).toMatchObject({ reason: "failed", failed: true });
    expect(getUser).toHaveBeenCalledTimes(1);
  });
  it("what counts as a blip: unreachable, 5xx, 429, a gateway page with no status — not 401/403", () => {
    expect(transientAuthError(new AuthRetryableFetchError("x", 0))).toBe(true);
    expect(transientAuthError(new AuthApiError("x", 502, "c"))).toBe(true);
    expect(transientAuthError(new AuthApiError("x", 429, "c"))).toBe(true);
    expect(transientAuthError(new AuthUnknownError("<html>502</html>", null))).toBe(true);
    expect(transientAuthError(new AuthApiError("x", 401, "c"))).toBe(false);
    expect(transientAuthError(new AuthApiError("x", 403, "c"))).toBe(false);
    expect(transientAuthError(new AuthApiError("refresh_token_already_used", 400, "refresh_token_already_used"))).toBe(false);
  });
});

describe("the layout and the middleware act on the answer, not on an empty hand", () => {
  it("the app layout: a failed check goes to /sign-in-check and is reported; a refused session is reported; nobody goes to /login; a failed profile read is not the onboarding wall", () => {
    const l = read("src/app/(app)/layout.tsx");
    expect(l).toContain("const check = await checkUser(supabase);");
    expect(l).toMatch(/reportError\("app-layout\.sign-in-check", check\.error,[^\n]*\n\s*redirect\("\/sign-in-check"\);/);
    expect(l).toContain('if (check.reason === "refused") {');
    expect(l).toContain('reportError("app-layout.signed-out", check.error,');
    expect(l).toContain('const user = check.user;\n  if (!user) redirect("/login");');
    expect(l).not.toContain("} = await supabase.auth.getUser();");
    expect(l).toMatch(/if \(profileErr && profileErr\.code !== "PGRST116"\) \{\s*reportError\("app-layout\.profile-read", profileErr,[^\n]*\n\s*redirect\("\/sign-in-check"\);/);
  });
  it("the middleware: a failed check answers a page with its own 503 Try Again page (no cookie write, nothing cached) and an API call with a 503", () => {
    const m = read("src/lib/supabase/middleware.ts");
    expect(m).toContain("const check = await checkUser(supabase);");
    expect(m).toContain('  "/sign-in-check",');
    expect(m).toMatch(/if \(check\.failed\) \{\s*if \(pathname\.startsWith\("\/api\/"\)\) \{\s*return new NextResponse\("Couldn't check your sign-in just now — try again\.", \{ status: 503 \}\);\s*\}\s*return new NextResponse\(SIGN_IN_CHECK_HTML, \{ status: 503, headers: \{ "content-type": "text\/html; charset=utf-8", "cache-control": "no-store" \} \}\);\s*\}/);
    expect(m).toContain('return new NextResponse("Your session expired — please sign in again.", { status: 401 });');
    expect(m).toContain(">Try Again</button>");
  });
  it("the Try Again page lives outside the app shell and goes back on a tap", () => {
    expect(read("src/app/sign-in-check/page.tsx")).toContain("<SignInCheckFailed />");
    const c = read("src/components/sign-in-check-failed.tsx");
    expect(c).toContain("Nothing was lost");
    expect(c).toContain("Try Again");
    expect(c).toContain("window.history.back()");
  });
});
