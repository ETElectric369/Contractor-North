"use client";

import { useState, useTransition } from "react";
import { BookUser, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { connectCardDav, disconnectCardDav } from "./carddav-actions";
import { useRouter } from "next/navigation";

/**
 * iCLOUD CONTACTS — connect once, and North's own contact picker works the same on every screen.
 * The app-specific password is generated at appleid.apple.com (Sign-In & Security → App-Specific
 * Passwords), is revocable there any time, and is never the real Apple ID password. Stored in
 * YOUR North database, shown here so the connection is never invisible (the token-portal law:
 * every connection needs an off switch and a UI that admits it exists).
 */
export function CardDavCard({
  connected,
  appleId,
  count,
  lastSynced,
}: {
  connected: boolean;
  appleId?: string;
  count?: number;
  lastSynced?: string | null;
}) {
  const router = useRouter();
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [syncing, setSyncing] = useState(false);

  async function sync() {
    setSyncing(true);
    setMsg(null);
    try {
      const res = await fetch("/api/carddav/sync", { method: "POST" });
      const j = (await res.json()) as { ok: boolean; error?: string; pulled?: number; total?: number };
      setMsg(j.ok ? `Synced — ${j.total} contacts (${j.pulled} new or changed).` : (j.error ?? "Sync failed."));
      router.refresh();
    } catch {
      setMsg("Sync didn't reach the server — try again.");
    } finally {
      setSyncing(false);
    }
  }

  if (connected) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          <BookUser className="mr-1 inline h-4 w-4 text-brand" /> Connected as{" "}
          <span className="font-medium">{appleId}</span> · {count ?? 0} contacts synced
          {lastSynced ? ` · last sync ${new Date(lastSynced).toLocaleString()}` : ""}
        </p>
        <p className="text-xs text-slate-400">
          Powers the &ldquo;Add from my Contacts&rdquo; picker everywhere — same sheet on the Mac,
          the phone, and the installed app. Your book, your database; disconnect wipes the copy.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={sync} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} /> {syncing ? "Syncing…" : "Sync now"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await disconnectCardDav();
                setMsg(r.ok ? "Disconnected — the synced copy is deleted." : (r.error ?? "Couldn't disconnect."));
                router.refresh();
              })
            }
          >
            Disconnect
          </Button>
        </div>
        {msg && <p className="text-xs font-medium text-slate-500">{msg}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Connect your iCloud Contacts and North gets its own contact picker — the same fast sheet on
        every screen, instead of each browser&apos;s moody autofill.
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-500">
        <li>
          Go to <span className="font-medium">appleid.apple.com → Sign-In &amp; Security → App-Specific Passwords</span> and
          generate one (call it &ldquo;North&rdquo;).
        </li>
        <li>Paste it below with your Apple ID. It&apos;s revocable there any time and is never your real password.</li>
      </ol>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="cd-id">Apple ID</Label>
          <Input id="cd-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="you@icloud.com" className="w-56" autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="cd-pw">App-specific password</Label>
          <Input id="cd-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="xxxx-xxxx-xxxx-xxxx" className="w-48" autoComplete="off" />
        </div>
        <Button
          size="sm"
          disabled={pending || !id.trim() || !pw.trim()}
          onClick={() =>
            start(async () => {
              setMsg(null);
              const r = await connectCardDav(id, pw);
              if (!r.ok) { setMsg(r.error ?? "Couldn't connect."); return; }
              setMsg("Connected — now run the first sync.");
              setPw("");
              router.refresh();
            })
          }
        >
          {pending ? "Checking…" : "Connect"}
        </Button>
      </div>
      {msg && <p className="text-xs font-medium text-rose-600">{msg}</p>}
    </div>
  );
}
