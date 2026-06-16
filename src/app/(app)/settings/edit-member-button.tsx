"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { updateMember, updateMemberAuth } from "./actions";

interface Member {
  id: string;
  full_name: string | null;
  email: string | null;
  phone?: string | null;
  role: string;
  active: boolean;
  home_address?: string | null;
}

/** Owner/admin edit for a team member: name/role/active + login email/password. */
export function EditMemberButton({
  member,
  isSelf,
  authConfigured,
}: {
  member: Member;
  isSelf: boolean;
  authConfigured: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [name, setName] = useState(member.full_name ?? "");
  const [phone, setPhone] = useState(member.phone ?? "");
  const [homeAddress, setHomeAddress] = useState(member.home_address ?? "");
  const [role, setRole] = useState(member.role);
  const [active, setActive] = useState(member.active);
  const [email, setEmail] = useState(member.email ?? "");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  function save() {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await updateMember(member.id, {
        full_name: name,
        phone,
        home_address: homeAddress,
        role: isSelf ? undefined : role,
        active: isSelf ? undefined : active,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");

      // Login changes go through the admin path only when something changed.
      const emailChanged = email.trim().toLowerCase() !== (member.email ?? "").toLowerCase();
      if (emailChanged || password) {
        const authRes = await updateMemberAuth(member.id, {
          email: emailChanged ? email : undefined,
          password: password || undefined,
        });
        if (!authRes.ok) return setError(authRes.error ?? "Profile saved, but login change failed.");
      }
      setDone(password ? `Saved. New password: ${password}` : "Saved.");
      setPassword("");
      router.refresh();
    });
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Edit member">
        <Pencil className="h-4 w-4" />
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={`Edit ${member.full_name ?? "member"}`}>
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {done && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{done}</div>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="m-name">Name</Label>
              <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="m-phone">Phone</Label>
              <Input id="m-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="m-home">Home address</Label>
            <Input id="m-home" value={homeAddress} onChange={(e) => setHomeAddress(e.target.value)} placeholder="For auto-mileage from home to the job" />
          </div>
          {!isSelf && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="m-role">Role</Label>
                <Select id="m-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="admin">Admin</option>
                  <option value="office">Office</option>
                  <option value="tech">Tech</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="m-active">Status</Label>
                <Select id="m-active" value={active ? "active" : "inactive"} onChange={(e) => setActive(e.target.value === "active")}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </Select>
              </div>
            </div>
          )}

          <div className="border-t border-slate-100 pt-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Login</div>
            {!authConfigured && (
              <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Changing email or password needs <code>SUPABASE_SERVICE_ROLE_KEY</code> in Vercel. Until then this is read-only.
              </div>
            )}
            <div>
              <Label htmlFor="m-email">Email</Label>
              <Input id="m-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!authConfigured} />
            </div>
            <div className="mt-3">
              <Label htmlFor="m-pw">New password (optional)</Label>
              <div className="flex gap-2">
                <Input id="m-pw" type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave blank to keep" disabled={!authConfigured} />
                <Button type="button" size="sm" variant="outline" onClick={() => setShowPw((v) => !v)} disabled={!authConfigured} aria-label="Toggle password">
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
            <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
