import { getOrgSettings } from "@/lib/org-settings";
import { isStaffRole } from "@/lib/actions/perms";

/**
 * THE RULE ITSELF, WITH NO READS IN IT (0286, "Office Can See This"): the owner always sees the
 * owner's own money, office staff see it only while the owner's switch is on, and nobody else ever
 * does. A bank download is owner money line by line — the draw, the personal spending — so the bank
 * doors ask this same question through `viewerSortsBank` below.
 *
 * IT IS A FUNCTION BECAUSE IT HAD BECOME FOUR SENTENCES. `viewerIsOwner || office_sees_owner_money`
 * was typed out on /analytics, in the accountant page's viewer and again in its download route, and
 * read a fourth way here; Reconcile's statement door would have been a fifth. Four spellings of one
 * rule is the two-doors defect this repo keeps paying for: one of them loses the staff test, or
 * gains a role, and nobody notices until a figure shows up on a screen it was kept off. Every door
 * calls this one function.
 */
export function viewerSeesOwnerMoney(role: string | null | undefined, officeSeesOwnerMoney: boolean): boolean {
  if (!isStaffRole(role)) return false;
  if (role === "owner") return true;
  return officeSeesOwnerMoney === true;
}

/**
 * WHO SORTS A BANK DOWNLOAD. A bank download shows the owner's draw and personal spending, line by
 * line, and those are the owner's money: the Owner's Draw card's own switch says who else may see
 * them (0286, "Office Can See This"). So the owner always sorts bank downloads, and office staff do
 * only while that switch is on. Off, an office viewer sees no bank card, no drop line and no My Day
 * item, and every bank door refuses them. Techs never reach any of it (requireStaff, 0363 RLS).
 *
 * One read of the viewer's role and the company's settings; a failed read is a no.
 */
export async function viewerSortsBank(supabase: any, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", userId).maybeSingle();
  if (!me?.org_id) return false;
  if (!isStaffRole(me.role)) return false;
  // THE OWNER'S ANSWER NEVER DEPENDS ON THE SWITCH, so their yes costs no second read: the one rule
  // asked with the switch OFF already says yes for the owner, and it is the same rule either way.
  if (viewerSeesOwnerMoney(me.role, false)) return true;
  const { data: org } = await supabase.from("organizations").select("settings").eq("id", me.org_id).maybeSingle();
  if (!org) return false;
  return viewerSeesOwnerMoney(me.role, getOrgSettings((org as { settings?: unknown }).settings).office_sees_owner_money);
}

/** What a bank card says to a viewer who doesn't sort bank downloads. */
export const OWNER_SORTS_BANK = "The owner sorts bank downloads: they show the owner's own money. Nothing here was changed.";
