"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { updateMyPassword } from "./actions";

export function SetPasswordForm() {
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) return setError("Password must be at least 8 characters.");
    if (pw !== confirm) return setError("The passwords don't match.");
    start(async () => {
      const res = await updateMyPassword(pw);
      if (!res.ok) return setError(res.error ?? "Could not update your password.");
      router.replace("/planner");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="pw">New password</Label>
        <Input id="pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" autoFocus />
      </div>
      <div>
        <Label htmlFor="pw2">Confirm password</Label>
        <Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving</> : "Save password & continue"}
      </Button>
    </form>
  );
}
