"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Mail, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { inviteSiteCollaborator, revokeSiteCollaborator } from "./collaborator-actions";

type Collab = { id: string; invited_email: string; user_id: string | null; created_at: string };

/**
 * Invite an outside SEO/content pro to manage this org's website articles. They get access to ONLY
 * the Articles workspace (/content) — never jobs, money, customers, or payroll (see migration 0111).
 * This is the "work with your SEO person" door: they publish into your site, you stay in control.
 */
export function CollaboratorsManager({ initial }: { initial: Collab[] }) {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [pending, start] = useTransition();
  const [lastLink, setLastLink] = useState<string | null>(null);

  function invite() {
    const e = email.trim();
    if (!e) return;
    start(async () => {
      const res = await inviteSiteCollaborator(e);
      if (!res.ok) { toast(res.error ?? "Couldn't send the invite.", "error"); return; }
      toast("Invite sent", "success");
      setEmail("");
      setLastLink(res.link ?? null);
      router.refresh();
    });
  }

  function revoke(c: Collab) {
    start(async () => {
      const res = await revokeSiteCollaborator(c.id);
      if (!res.ok) { toast(res.error ?? "Couldn't remove access.", "error"); return; }
      toast("Access removed", "success");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Invite your SEO or content person to write and publish articles on your site. They get a
        workspace with <strong>only your articles</strong> — never your jobs, customers, money, or
        crew. Remove their access anytime.
      </p>

      {initial.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {initial.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3">
              <Mail className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-800">{c.invited_email}</div>
                <div className="text-xs text-slate-400">Invited {formatDate(c.created_at)}</div>
              </div>
              <Badge tone={c.user_id ? "green" : "amber"}>{c.user_id ? "active" : "pending"}</Badge>
              <button
                type="button"
                onClick={() => revoke(c)}
                disabled={pending}
                className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                title="Remove access"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="seo@agency.com"
            onKeyDown={(e) => e.key === "Enter" && invite()}
          />
        </div>
        <Button type="button" onClick={invite} disabled={pending || !email.trim()}>
          <UserPlus className="h-4 w-4" /> Invite
        </Button>
      </div>

      {lastLink && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          <span className="truncate text-slate-500">Share this link if the email doesn&apos;t arrive: {lastLink}</span>
          <button
            type="button"
            onClick={() => { navigator.clipboard?.writeText(lastLink); toast("Link copied", "success"); }}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-white px-2 py-1 font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            <Copy className="h-3.5 w-3.5" /> Copy
          </button>
        </div>
      )}
    </div>
  );
}
