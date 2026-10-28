import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE OWNER-ONLY SETTINGS ARE PINNED IN THE DATABASE (0397, cn-v1134), read from the migration file
 * the way features.test.ts reads 0352: the trigger, the keys it pins, the words it refuses with, and
 * that it leaves 0352's switch-board pin alone (applied migrations are immutable; the DB proof is
 * src/lib/owner-settings.integration.test.ts against the test database).
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

/** Every settings key 0397 pins, and the one action each refusal names. */
const PINNED_OWNER_SETTINGS = {
  office_sees_owner_money: "Only the owner changes who sees the owner''s money, on the Analytics page.",
  lead_inbound_secret: "Only North sets the inbound lead key. Ask North to change it.",
} as const;

describe("migration 0397 pins the owner-only settings", () => {
  const sql = migration("0397_");
  const fn = sql.slice(sql.indexOf("create or replace function public.pin_owner_settings()"), sql.indexOf("revoke execute on function public.pin_owner_settings()"));

  it("one BEFORE UPDATE OF settings trigger on organizations, named pin_owner_settings, twice-safe", () => {
    expect(sql).toContain("drop trigger if exists pin_owner_settings on public.organizations;");
    expect(sql).toMatch(/create trigger pin_owner_settings\s+before update of settings on public\.organizations\s+for each row execute function public\.pin_owner_settings\(\);/);
    expect(fn.length).toBeGreaterThan(200);
  });

  it("every pinned key is read on both OLD and NEW, and refused in its own words", () => {
    for (const [key, words] of Object.entries(PINNED_OWNER_SETTINGS)) {
      expect(fn, key).toContain(`(new.settings -> '${key}') is distinct from (old.settings -> '${key}')`);
      expect(fn, key).toContain(`raise exception '${words}'`);
    }
    // The writer rule: a privileged writer (a migration, the service role) first, then the active owner.
    expect(fn).toContain("if public.is_privileged_writer() then");
    expect(fn).toContain("public.app_user_role() is distinct from 'owner'");
    // Never a silent drop: the function does not carry a value through or strip a key.
    expect(fn).not.toMatch(/jsonb_set|coalesce\(new\.settings, '\{\}'::jsonb\) - /);
  });

  it("the refusals are plain words naming one action, not developer text", () => {
    for (const words of Object.values(PINNED_OWNER_SETTINGS)) {
      expect(words).toMatch(/^Only /);
      expect(words).not.toMatch(/_|0\d{3}|settings\./);
    }
  });

  it("leaves 0352's switch-board pin alone (never drops or redefines pin_org_features)", () => {
    expect(sql).not.toMatch(/drop trigger (if exists )?pin_org_features/i);
    expect(sql).not.toMatch(/function public\.pin_org_features\(\)\s*returns/i);
    expect(sql).not.toMatch(/create or replace function public\.(set_org_feature|feature_keys|org_feature_on|guard_owner_money_visibility)/i);
    // and keeps 0286's guard: it is asserted present on the test database, never dropped here.
    expect(sql).not.toMatch(/drop trigger (if exists )?guard_owner_money_visibility/i);
  });

  it("is not callable from outside the database and checks itself", () => {
    expect(sql).toContain("revoke execute on function public.pin_owner_settings() from public, anon, authenticated;");
    expect(sql).toContain("if to_regprocedure('public.pin_owner_settings()') is null then");
    expect(sql).toMatch(/tgname = 'pin_owner_settings' and tgrelid = 'public\.organizations'::regclass/);
    expect(sql).toContain("raise notice '0397: the owner-only settings are pinned.';");
    expect(sql).toContain("set local lock_timeout = '3s';");
  });

  it("the keys it pins are the ones the app keeps owner-only or server-only, and nothing a staff door writes", () => {
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/settings/actions.ts"), "utf8");
    // Both pinned keys are PROTECTED_SETTINGS_KEYS (the general save strips them).
    const protectedLine = actions.match(/const PROTECTED_SETTINGS_KEYS = \[([^\]]*)\]/)?.[1] ?? "";
    for (const key of Object.keys(PINNED_OWNER_SETTINGS)) expect(protectedLine, key).toContain(`"${key}"`);
    // custom_domain and public_handle have STAFF setters writing with the person's own client, so
    // they are not pinned (a pin would refuse the office's own saves).
    expect(sql).not.toMatch(/'custom_domain'|'public_handle'/);
    expect(actions).toMatch(/export async function setCustomDomain[\s\S]*?const ctx = await requireStaff\(\);/);
    expect(actions).toMatch(/export async function setPublicHandle[\s\S]*?const ctx = await requireStaff\(\);/);
    // lead_inbound_secret has no app setter at all: every mention in src is a read, a strip or a comment.
    const writes: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name.name) && !/\.test\.tsx?$/.test(name.name)) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (line.includes("lead_inbound_secret") && !/^\s*(\*|\/\/|\/\*)|\.eq\(|PROTECTED_SETTINGS_KEYS|^\s*\*/.test(line)) writes.push(`${p}:${i + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(writes).toEqual([]);
    const analytics = readFileSync(join(process.cwd(), "src/app/(app)/analytics/actions.ts"), "utf8");
    expect(analytics).toContain('if (me.role !== "owner") return { ok: false, error: "Only the owner can change who sees this." };');
    expect(analytics).toContain("office_sees_owner_money: on === true");
  });
});
