import { getOrgSettings } from "@/lib/org-settings";
import { isStaffRole } from "@/lib/actions/perms";

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
  if (me.role === "owner") return true;
  if (!isStaffRole(me.role)) return false;
  const { data: org } = await supabase.from("organizations").select("settings").eq("id", me.org_id).maybeSingle();
  if (!org) return false;
  return getOrgSettings((org as { settings?: unknown }).settings).office_sees_owner_money;
}

/** What a bank card says to a viewer who doesn't sort bank downloads. */
export const OWNER_SORTS_BANK = "The owner sorts bank downloads: they show the owner's own money. Nothing here was changed.";
