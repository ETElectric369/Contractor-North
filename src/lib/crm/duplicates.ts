/**
 * Duplicate-contact detection for the CRM "Find duplicates" tool. Groups customers that are LIKELY
 * the same person/company by a shared strong signal — same phone, same email, or same normalized
 * name — using union-find so transitive matches chain into one group (A≈B by phone, B≈C by email →
 * one group A,B,C). Detection only SUGGESTS; a human picks the keeper and confirms before the
 * (destructive) merge runs. Pure + unit-tested.
 */
export type DupCustomer = {
  id: string;
  name: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  type?: string | null;
  status?: string | null;
  created_at?: string | null;
};
export type DupGroup = { reason: string; members: DupCustomer[] };

export const normPhone = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);
export const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
// Strip ALL non-alphanumerics (spaces + punctuation) so "O'Brien Plumbing", "obrien plumbing", and
// "OBrien  Plumbing" all collapse to the same key — punctuation joins here, it doesn't split.
export const normName = (n: string | null | undefined) => (n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The crosscheck used when a lead is about to become a customer (estimate accepted): does this
 * incoming contact ALREADY exist in the book? Returns the id of the first existing customer that
 * shares a STRONG signal — same phone (≥7 digits), same email, or same normalized name — using the
 * exact same keys `findDuplicateGroups` groups on, so "accept an estimate" and "find duplicates"
 * never disagree. null = genuinely new. Pure + unit-tested.
 */
export function findMatchingCustomerId(
  candidate: { name?: string | null; email?: string | null; phone?: string | null },
  existing: DupCustomer[],
): string | null {
  const p = normPhone(candidate.phone);
  const e = normEmail(candidate.email);
  const n = normName(candidate.name);
  for (const c of existing) {
    if (p.length >= 7 && normPhone(c.phone) === p) return c.id;
    if (e && normEmail(c.email) === e) return c.id;
    if (n && normName(c.name) === n) return c.id;
  }
  return null;
}

const phoneKey = (c: DupCustomer) => { const p = normPhone(c.phone); return p.length >= 7 ? p : ""; };
const emailKey = (c: DupCustomer) => normEmail(c.email);
const nameKey = (c: DupCustomer) => normName(c.name);

/** Do 2+ members share a non-empty key under `keyFn`? (Used to label WHY a group is grouped.) */
function shares(members: DupCustomer[], keyFn: (c: DupCustomer) => string): boolean {
  const seen = new Set<string>();
  for (const m of members) {
    const k = keyFn(m);
    if (!k) continue;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

export function findDuplicateGroups(customers: DupCustomer[]): DupGroup[] {
  const parent = new Map<string, string>();
  for (const c of customers) parent.set(c.id, c.id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const linkBy = (keyFn: (c: DupCustomer) => string) => {
    const buckets = new Map<string, string[]>();
    for (const c of customers) {
      const k = keyFn(c);
      if (!k) continue;
      const arr = buckets.get(k) ?? [];
      arr.push(c.id);
      buckets.set(k, arr);
    }
    for (const ids of buckets.values()) for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  };
  linkBy(phoneKey);
  linkBy(emailKey);
  linkBy(nameKey);

  const groups = new Map<string, DupCustomer[]>();
  for (const c of customers) {
    const r = find(c.id);
    const arr = groups.get(r) ?? [];
    arr.push(c);
    groups.set(r, arr);
  }

  const byCreatedAsc = (a: DupCustomer, b: DupCustomer) => (a.created_at ?? "") < (b.created_at ?? "") ? -1 : (a.created_at ?? "") > (b.created_at ?? "") ? 1 : 0;
  const out: DupGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const reasons: string[] = [];
    if (shares(members, phoneKey)) reasons.push("phone");
    if (shares(members, emailKey)) reasons.push("email");
    if (shares(members, nameKey)) reasons.push("name");
    out.push({ reason: reasons.join(" + ") || "similar", members: [...members].sort(byCreatedAsc) });
  }
  // biggest / most-actionable groups first
  return out.sort((a, b) => b.members.length - a.members.length);
}
