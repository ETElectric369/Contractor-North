/**
 * A STAND-IN DATABASE FOR THE JOIN DOOR'S TESTS (cn-v1183): it honours the filters a read asks for
 * (eq, is, gt, order, limit) and returns only the columns the read lists, so a door that forgot a
 * filter or a column fails here as it would against the real thing. Every call is logged, and the
 * service client and the cookie client are separate objects over the same rows.
 */
export type Row = Record<string, unknown>;
export type AuthUser = {
  id: string;
  email: string;
  password: string;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  user_metadata?: Record<string, unknown>;
};

export type World = {
  tables: Record<string, Row[]>;
  users: AuthUser[];
  /** Who is signed in on the cookie client. */
  session: string | null;
  log: string[];
  froms: string[];
  adminCalls: { name: string; args: unknown[] }[];
  writes: { table: string; patch: Row; filters: [string, string, unknown][] }[];
  fail: Partial<Record<"createUser" | "updateUserById" | "signIn" | "accept" | "profilesRead" | "getUserById", { code?: string; message: string; status?: number }>>;
};

export function newWorld(): World {
  return { tables: { invitations: [], organizations: [], profiles: [] }, users: [], session: null, log: [], froms: [], adminCalls: [], writes: [], fail: {} };
}

function project(r: Row, cols: string | null): Row {
  if (!cols || cols.trim() === "*") return { ...r };
  const out: Row = {};
  for (const c of cols.split(",").map((s) => s.trim())) out[c] = r[c];
  return out;
}

function table(world: World, name: string, who: "svc" | "cookie") {
  world.froms.push(`${who}:${name}`);
  const filters: [string, string, unknown][] = [];
  let cols: string | null = null;
  let patch: Row | null = null;
  let orderBy: { col: string; asc: boolean } | null = null;
  let lim: number | null = null;
  const rows = () => {
    let hit = (world.tables[name] ?? []).filter((r) =>
      filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : op === "is" ? (r[c] ?? null) === v : op === "gt" ? String(r[c]) > String(v) : true)),
    );
    if (orderBy) {
      const { col, asc } = orderBy;
      hit = [...hit].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    if (lim != null) hit = hit.slice(0, lim);
    return hit;
  };
  const result = () => {
    if (name === "profiles" && world.fail.profilesRead && !patch) return { data: null, error: world.fail.profilesRead };
    const hit = rows();
    if (patch) {
      world.writes.push({ table: name, patch, filters: [...filters] });
      if (name === "invitations") world.log.push("tidy");
      for (const r of hit) Object.assign(r, patch);
    }
    return { data: hit.map((r) => project(r, cols)), error: null };
  };
  const chain: any = {
    select(c?: string) {
      cols = c ?? "*";
      return chain;
    },
    update(p: Row) {
      patch = p;
      return chain;
    },
    eq(c: string, v: unknown) {
      filters.push(["eq", c, v]);
      return chain;
    },
    is(c: string, v: unknown) {
      filters.push(["is", c, v]);
      return chain;
    },
    gt(c: string, v: unknown) {
      filters.push(["gt", c, v]);
      return chain;
    },
    order(col: string, o?: { ascending?: boolean }) {
      orderBy = { col, asc: o?.ascending !== false };
      return chain;
    },
    limit(n: number) {
      lim = n;
      return chain;
    },
    maybeSingle: async () => {
      const r = result();
      if (r.error) return r;
      return { data: r.data[0] ?? null, error: null };
    },
    single: async () => {
      const r = result();
      return { data: r.data?.[0] ?? null, error: r.error };
    },
    then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) {
      return Promise.resolve(result()).then(ok, err);
    },
  };
  return chain;
}

export function serviceClient(world: World) {
  const call = (name: string, ...args: unknown[]) => world.adminCalls.push({ name, args });
  return {
    from: (name: string) => table(world, name, "svc"),
    auth: {
      admin: {
        async getUserById(id: string) {
          call("getUserById", id);
          if (world.fail.getUserById) return { data: { user: null }, error: world.fail.getUserById };
          const u = world.users.find((x) => x.id === id);
          return { data: { user: u ? { ...u } : null }, error: u ? null : { message: "User not found", status: 404 } };
        },
        async createUser(attrs: { email: string; password: string; email_confirm?: boolean; user_metadata?: Record<string, unknown> }) {
          call("createUser", attrs);
          world.log.push("createUser");
          if (world.fail.createUser) return { data: { user: null }, error: world.fail.createUser };
          if (world.users.some((u) => u.email === attrs.email)) {
            return { data: { user: null }, error: { code: "email_exists", status: 422, message: "A user with this email address has already been registered" } };
          }
          const id = `user-${world.users.length + 1}`;
          world.users.push({
            id,
            email: attrs.email,
            password: attrs.password,
            email_confirmed_at: attrs.email_confirm ? "2026-11-22T12:00:00Z" : null,
            last_sign_in_at: null,
            user_metadata: attrs.user_metadata,
          });
          // handle_new_user: the profile row, no company.
          world.tables.profiles.push({ id, email: attrs.email, full_name: attrs.user_metadata?.full_name ?? attrs.email, org_id: null, role: "tech", active: true });
          return { data: { user: { id } }, error: null };
        },
        async updateUserById(id: string, attrs: { password?: string; email_confirm?: boolean; user_metadata?: Record<string, unknown> }) {
          call("updateUserById", id, attrs);
          world.log.push("updateUserById");
          if (world.fail.updateUserById) return { data: { user: null }, error: world.fail.updateUserById };
          const u = world.users.find((x) => x.id === id);
          if (!u) return { data: { user: null }, error: { message: "User not found" } };
          if (attrs.password) u.password = attrs.password;
          if (attrs.email_confirm) u.email_confirmed_at = "2026-11-22T12:00:00Z";
          if (attrs.user_metadata) u.user_metadata = attrs.user_metadata;
          return { data: { user: { id } }, error: null };
        },
      },
    },
  };
}

export function cookieClient(world: World) {
  const me = () => world.users.find((u) => u.id === world.session) ?? null;
  return {
    from: (name: string) => table(world, name, "cookie"),
    auth: {
      async getUser() {
        const u = me();
        return { data: { user: u ? { id: u.id, email: u.email } : null }, error: null };
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        world.log.push("signIn");
        if (world.fail.signIn) return { data: {}, error: world.fail.signIn };
        const u = world.users.find((x) => x.email === email && x.password === password && x.email_confirmed_at);
        if (!u) return { data: {}, error: { message: "Invalid login credentials" } };
        u.last_sign_in_at = "2026-11-22T12:00:00Z";
        world.session = u.id;
        return { data: { user: { id: u.id } }, error: null };
      },
      async signOut() {
        world.session = null;
        return { error: null };
      },
    },
    async rpc(fn: string) {
      if (fn !== "accept_invitation") throw new Error(`unexpected rpc ${fn}`);
      world.log.push("accept");
      if (world.fail.accept) return { data: null, error: world.fail.accept };
      const u = me();
      const prof = world.tables.profiles.find((p) => p.id === u?.id);
      if (!u || !prof) return { data: null, error: { message: "Not authenticated." } };
      if (prof.org_id) return { data: prof.org_id, error: null };
      const inv = world.tables.invitations
        .filter((i) => String(i.email) === u.email.toLowerCase() && i.accepted_at == null && String(i.expires_at) > "2026-11-22T12:00:00Z")
        .sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1))[0];
      if (!inv) return { data: null, error: { message: "No pending invitation for your email." } };
      prof.org_id = inv.org_id;
      prof.role = inv.role;
      inv.accepted_at = "2026-11-22T12:00:00Z";
      return { data: inv.org_id, error: null };
    },
  };
}
