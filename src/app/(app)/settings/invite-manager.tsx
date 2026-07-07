"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Mail, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { createInvitation, deleteInvitation } from "./actions";

interface Invite {
  id: string;
  email: string;
  role: string;
  token: string;
  accepted_at: string | null;
  created_at: string;
}

export function InviteManager({
  invites,
  siteUrl,
}: {
  invites: Invite[];
  siteUrl: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onInvite(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await createInvitation(formData);
      if (!res.ok) {
        setError(res.error ?? "Could not invite.");
        return;
      }
      toast("Invite emailed — or copy the link to text it", "success");
      router.refresh();
    });
  }

  function remove(id: string, email: string) {
    if (!confirm(`Revoke the invite for ${email}? The signup link will stop working.`)) return;
    start(async () => {
      const res = await deleteInvitation(id);
      if (!res?.ok) { toast(res?.error ?? "Couldn't revoke invite — try again.", "error"); return; }
      toast("Invite revoked", "success");
      router.refresh();
    });
  }

  function copyLink(email: string) {
    const link = `${siteUrl}/login?mode=signup&email=${encodeURIComponent(email)}`;
    navigator.clipboard?.writeText(link);
    setCopied(email);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className="space-y-4">
      <form action={onInvite} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Label htmlFor="invite-email">Invite by email</Label>
          <Input id="invite-email" name="email" type="email" placeholder="crew@company.com" required />
        </div>
        <div className="sm:w-40">
          <Label htmlFor="invite-role">Role</Label>
          <Select id="invite-role" name="role" defaultValue="tech">
            <option value="tech">Tech</option>
            <option value="office">Office</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </Select>
        </div>
        <Button type="submit" disabled={pending}>
          <Plus className="h-4 w-4" /> Invite
        </Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <p className="text-xs text-slate-400">
        The invited person signs up with this email; when they create their
        account they'll automatically join your company with the role you set.
      </p>

      {invites.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {invites.map((inv) => (
            <li key={inv.id} className="flex items-center gap-3 px-4 py-2.5">
              <Mail className="h-4 w-4 text-slate-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-900">
                  {inv.email}
                </div>
                <div className="text-xs text-slate-400">
                  Invited {formatDate(inv.created_at)}
                </div>
              </div>
              <Badge tone="slate">{inv.role}</Badge>
              {inv.accepted_at ? (
                <Badge tone="green">accepted</Badge>
              ) : (
                <>
                  <button
                    onClick={() => copyLink(inv.email)}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    title="Copy signup link"
                  >
                    {copied === inv.email ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    onClick={() => remove(inv.id, inv.email)}
                    disabled={pending}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    title="Revoke invite"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
