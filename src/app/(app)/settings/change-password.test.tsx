import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * CHANGE MY PASSWORD (cn-v1202): ONE row in Settings › You › Sign-in & security. Closed it is one
 * button; open, two password boxes (new-password, so a password manager offers and saves it), Save
 * and Cancel; done, the row closes and says whether the other devices were signed out; a refusal
 * stays under the boxes and keeps what was typed. The unit project has no DOM, so the row's hooks
 * are a small hand-held stand-in: each draw calls the component, the test presses what it drew
 * (an onClick, an onChange, the form's onSubmit), and the next draw reads the new state. The drawn
 * tree is then rendered by the real react-dom. Every clickable is Title Case in both languages.
 */
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  i: 0,
  refs: [] as { current: unknown }[],
  r: 0,
  pending: [] as Promise<unknown>[],
  lang: "en" as "en" | "es",
  isPending: false,
  props: {} as { email?: string },
}));

vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      const i = h.i++;
      if (!(i in h.states)) h.states[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [h.states[i], (v: unknown) => (h.states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(h.states[i]) : v)];
    },
    useRef: (init: unknown) => {
      const i = h.r++;
      return (h.refs[i] ??= { current: init });
    },
    useTransition: () => [h.isPending, (fn: () => unknown) => void h.pending.push(Promise.resolve(fn()))],
  };
});
vi.mock("@/components/lang-provider", () => ({ useLang: () => h.lang }));
const updateMyPassword = vi.fn();
vi.mock("@/app/set-password/actions", () => ({ updateMyPassword: (...a: unknown[]) => updateMyPassword(...a) }));

import { ChangePassword } from "./change-password";
import { dict } from "@/lib/i18n";
import { titleCaseIn } from "../../../../tests/title-case-words";

type El = ReactElement<Record<string, any>>;
function draw(): El {
  h.i = 0;
  h.r = 0;
  return ChangePassword(h.props) as El;
}
function all(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out));
  else if (isValidElement(node)) {
    out.push(node as El);
    all((node as El).props.children, out);
  }
  return out;
}
const byId = (tree: El, id: string) => all(tree).find((e) => e.props.id === id)!;
const form = (tree: El) => all(tree).find((e) => e.type === "form")!;
const html = (tree: El) => renderToStaticMarkup(tree);
const words = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const buttons = (tree: El) => [...html(tree).matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => words(m[1])).filter(Boolean);
const settle = async () => {
  while (h.pending.length) await h.pending.shift();
};
function openRow() {
  const tree = draw();
  all(tree).find((e) => typeof e.props.onClick === "function")!.props.onClick();
  return draw();
}
function type(pw: string, confirm: string) {
  const tree = draw();
  byId(tree, "cp-pw").props.onChange({ target: { value: pw } });
  byId(tree, "cp-pw2").props.onChange({ target: { value: confirm } });
}
const submit = () => form(draw()).props.onSubmit({ preventDefault() {} });
/** A password built at run time, never a literal of a real one's shape. */
const typed = () => ` ${["larkspur", "meadow", String(7 * 6)].join("-")} `;

beforeEach(() => {
  h.states = [];
  h.refs = [];
  h.pending = [];
  h.lang = "en";
  h.isPending = false;
  h.props = {};
  updateMyPassword.mockReset();
});

describe("the row in both languages", () => {
  for (const lang of ["en", "es"] as const) {
    it(`${lang}: closed is one button; open is two new-password boxes, Save and Cancel; every clickable Title Case`, () => {
      h.lang = lang;
      const d = dict(lang);
      const closed = draw();
      expect(buttons(closed)).toEqual([d.sh_changeMyPassword]);
      expect(html(closed)).not.toContain("<input");
      const open = openRow();
      const out = html(open);
      expect(buttons(open)).toEqual([d.sh_savePassword, d.sh_btn_cancel]);
      expect(out.match(/<input[^>]*type="password"[^>]*autoComplete="new-password"|<input[^>]*autoComplete="new-password"[^>]*type="password"/gi)).toHaveLength(2);
      expect(words(out)).toContain(d.au_newPassword);
      expect(words(out)).toContain(d.au_confirmPassword);
      expect(out).toContain(`placeholder="${d.au_atLeast8}"`);
      for (const b of [...buttons(closed), ...buttons(open)]) expect(titleCaseIn(b, lang), b).toBe(true);
      if (lang === "es") expect(buttons(open).concat(buttons(closed))).toEqual(["Guardar Contraseña", "Cancelar", "Cambiar Mi Contraseña"]);
      else expect(buttons(open).concat(buttons(closed))).toEqual(["Save Password", "Cancel", "Change My Password"]);
    });
  }
});

describe("before the action is called", () => {
  it("under 8 and a mismatch are refused on the row, in the reader's language, and nothing is sent", () => {
    for (const lang of ["en", "es"] as const) {
      h.states = [];
      h.lang = lang;
      openRow();
      type("short", "short");
      submit();
      expect(words(html(draw()))).toContain(dict(lang).au_password8);
      type("long enough one", "long enough two");
      submit();
      expect(words(html(draw()))).toContain(dict(lang).au_passwordsDontMatch);
    }
    expect(updateMyPassword).not.toHaveBeenCalled();
  });
});

describe("the save", () => {
  it("calls the action ONCE with exactly what was typed, even on a double tap; done closes the row, empties the boxes and says the other devices were signed out", async () => {
    updateMyPassword.mockResolvedValue({ ok: true, othersSignedOut: true });
    openRow();
    const pw = typed();
    type(pw, pw);
    submit();
    submit();
    await settle();
    expect(updateMyPassword).toHaveBeenCalledTimes(1);
    expect(updateMyPassword).toHaveBeenCalledWith(pw);
    const done = draw();
    expect(html(done)).not.toContain("<input");
    expect(words(html(done))).toContain("Password changed. Your other devices will ask you to sign in again.");
    expect(buttons(done)).toEqual(["Change My Password"]);
    const reopened = openRow();
    expect(byId(reopened, "cp-pw").props.value).toBe("");
    expect(byId(reopened, "cp-pw2").props.value).toBe("");
  });

  it("when the other devices were not signed out it says only that the password changed; Spanish too", async () => {
    for (const [lang, line, other] of [
      ["en", "Password changed.", "other devices"],
      ["es", "Contraseña cambiada.", "otros dispositivos"],
    ] as const) {
      h.states = [];
      h.refs = [];
      h.lang = lang;
      updateMyPassword.mockResolvedValue({ ok: true, othersSignedOut: false });
      openRow();
      type(typed(), typed());
      submit();
      await settle();
      const out = words(html(draw()));
      expect(out).toContain(line);
      expect(out).not.toContain(other);
    }
    h.states = [];
    h.refs = [];
    h.lang = "es";
    updateMyPassword.mockResolvedValue({ ok: true, othersSignedOut: true });
    openRow();
    type(typed(), typed());
    submit();
    await settle();
    expect(words(html(draw()))).toContain("Contraseña cambiada. Tus otros dispositivos te pedirán iniciar sesión otra vez.");
  });

  it("a refusal shows the action's sentence in red under the boxes and keeps what was typed", async () => {
    const sentence = dict("en").au_samePassword;
    updateMyPassword.mockResolvedValue({ ok: false, error: sentence });
    openRow();
    const pw = typed();
    type(pw, pw);
    submit();
    await settle();
    const tree = draw();
    expect(html(tree)).toMatch(new RegExp(`<p class="[^"]*text-red-600[^"]*"[^>]*>${sentence.replace(/'/g, "&#x27;").replace(/\./g, "\\.")}</p>`));
    expect(byId(tree, "cp-pw").props.value).toBe(pw);
    expect(byId(tree, "cp-pw2").props.value).toBe(pw);
  });
});

describe("one door", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("Settings › You mounts it right under the passkeys, inside Sign-in & security", () => {
    const page = src("src/app/(app)/settings/page.tsx");
    expect(page).toMatch(/\{t\("sh_signInSecurity"\)\}<\/div>\s*<PasskeyManager passkeys=\{passkeys\} \/>\s*<ChangePassword email=\{profile\?\.email \?\? ""\} \/>\s*<\/div>/);
    expect(page.match(/<ChangePassword\b/g)).toHaveLength(1);
  });
  it("the account menu has no password row, and nothing else in src mounts the door", () => {
    expect(src("src/components/account-menu.tsx")).not.toMatch(/password|ChangePassword/i);
    const mounts: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.tsx$/.test(e.name) && !/\.test\./.test(e.name) && /<ChangePassword\b/.test(src(p))) mounts.push(p);
      }
    };
    walk("src");
    expect(mounts).toEqual(["src/app/(app)/settings/page.tsx"]);
  });
});

describe("the row never goes dead or quiet (skeptic #99)", () => {
  it("a refused save, then a second Save, calls the action a second time", async () => {
    updateMyPassword.mockResolvedValue({ ok: false, error: dict("en").au_samePassword });
    openRow();
    type(typed(), typed());
    submit();
    await settle();
    submit();
    await settle();
    expect(updateMyPassword).toHaveBeenCalledTimes(2);
  });
  it("an action that throws shows au_couldNotUpdate, and a Save after it still calls the action", async () => {
    updateMyPassword.mockRejectedValueOnce(new Error("network down"));
    openRow();
    type(typed(), typed());
    submit();
    await settle();
    expect(words(html(draw()))).toContain(dict("en").au_couldNotUpdate);
    updateMyPassword.mockResolvedValue({ ok: true, othersSignedOut: true });
    submit();
    await settle();
    expect(updateMyPassword).toHaveBeenCalledTimes(2);
  });
});

describe("a saved password is said as saved (cn-v1202)", () => {
  it("saved with the flag left: the row closes, empties the boxes and says its done line by othersSignedOut", async () => {
    for (const [others, line] of [
      [true, "Password changed. Your other devices will ask you to sign in again."],
      [false, "Password changed."],
    ] as const) {
      h.states = [];
      h.refs = [];
      updateMyPassword.mockResolvedValue({ ok: false, error: dict("en").au_savedButStuck, saved: true, othersSignedOut: others });
      openRow();
      type(typed(), typed());
      submit();
      await settle();
      const done = draw();
      expect(html(done)).not.toContain("<input");
      expect(words(html(done))).not.toContain(dict("en").au_savedButStuck);
      expect(words(html(done))).toContain(line);
      if (!others) expect(words(html(done))).not.toContain("other devices");
      const reopened = openRow();
      expect(byId(reopened, "cp-pw").props.value).toBe("");
    }
  });
});

describe("the form names its account", () => {
  it("with an email: a hidden username field first in the form; without one: none", () => {
    h.props = { email: "sam@example.com" };
    const out = html(openRow());
    const first = out.match(/<form[^>]*>(<input[^>]*\/>)/)![1];
    for (const a of ['type="text"', 'name="username"', 'autoComplete="username"', 'readOnly=""', 'tabindex="-1"', 'aria-hidden="true"', 'style="display:none"', 'value="sam@example.com"']) expect(first).toContain(a);
    h.states = [];
    h.props = {};
    expect(html(openRow())).not.toContain('autoComplete="username"');
  });
});

describe("the small promises", () => {
  it("Save is disabled while pending", () => {
    openRow();
    h.isPending = true;
    const save = all(draw()).find((e) => e.props.type === "submit")!;
    expect(save.props.disabled).toBe(true);
    h.isPending = false;
    expect(all(draw()).find((e) => e.props.type === "submit")!.props.disabled).toBe(false);
  });
  it("Cancel empties both boxes and the refusal", () => {
    openRow();
    type("short", "short");
    submit();
    expect(words(html(draw()))).toContain(dict("en").au_password8);
    const cancel = all(draw()).find((e) => e.props.type === "button" && typeof e.props.onClick === "function")!;
    cancel.props.onClick();
    const reopened = openRow();
    expect(byId(reopened, "cp-pw").props.value).toBe("");
    expect(byId(reopened, "cp-pw2").props.value).toBe("");
    expect(words(html(reopened))).not.toContain(dict("en").au_password8);
  });
  it("the done line is gone when the row is opened again", async () => {
    updateMyPassword.mockResolvedValue({ ok: true, othersSignedOut: false });
    openRow();
    type(typed(), typed());
    submit();
    await settle();
    expect(words(html(draw()))).toContain("Password changed.");
    const reopened = openRow();
    cancelOf(reopened).props.onClick();
    expect(words(html(draw()))).not.toContain("Password changed.");
  });
  it("each label's htmlFor is its box's id; the refusal carries role=alert", () => {
    openRow();
    type("short", "short");
    submit();
    const out = html(draw());
    expect(out).toMatch(/<label[^>]*for="cp-pw"[^>]*>[^<]*<\/label>\s*<input[^>]*id="cp-pw"/);
    expect(out).toMatch(/<label[^>]*for="cp-pw2"[^>]*>[^<]*<\/label>\s*<input[^>]*id="cp-pw2"/);
    expect(out).toMatch(new RegExp(`<p[^>]*role="alert"[^>]*>${dict("en").au_password8.replace(/\./g, "\\.")}</p>`));
  });
});
const cancelOf = (tree: El) => all(tree).find((e) => e.props.type === "button" && typeof e.props.onClick === "function")!;
