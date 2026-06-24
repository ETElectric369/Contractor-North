"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { createEmployee } from "./actions";

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let p = "";
  const buf = new Uint32Array(12);
  crypto.getRandomValues(buf);
  for (const n of buf) p += chars[n % chars.length];
  return p;
}

/** Add an employee directly — no email invite. You hand them the password. */
export function AddEmployeeButton({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(generatePassword());
  const [showPw, setShowPw] = useState(true);
  const [role, setRole] = useState("tech");
  const [rate, setRate] = useState(0);
  const [requireReset, setRequireReset] = useState(true);

  function save() {
    setError(null);
    start(async () => {
      const res = await createEmployee({
        full_name: name,
        email,
        password,
        role,
        hourly_rate: rate || null,
        requireReset,
      });
      if (!res.ok) return setError(res.error ?? "Could not create the employee.");
      setDone(`${name} can now log in with ${email} and the password below — send it to them${requireReset ? "; they'll set their own password on first login." : ", they can change it later."}`);
    });
  }

  function reset() {
    setOpen(false);
    setDone(null);
    setName("");
    setEmail("");
    setPassword(generatePassword());
    setRole("tech");
    setRate(0);
    setRequireReset(true);
    router.refresh();
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4" /> Add employee
      </Button>

      <Modal
        open={open}
        onClose={reset}
        title="Add an employee (no email invite)"
        footer={
          done ? undefined : (
            <ModalActions
              onCancel={reset}
              onSave={save}
              saving={pending}
              disabled={!configured || !name.trim() || !email.includes("@")}
              saveLabel="Create employee"
            />
          )
        }
      >
        {done ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{done}</div>
            <div className="rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm text-slate-800">{password}</div>
            <div className="flex justify-end">
              <Button onClick={reset}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {!configured && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                This needs <code>SUPABASE_SERVICE_ROLE_KEY</code> set in Vercel (Settings → Environment
                Variables, Production). Until then, use the email invite above.
              </div>
            )}
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label htmlFor="emp-name">Full name *</Label>
                <Input id="emp-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="col-span-2">
                <Label htmlFor="emp-email">Email (their login) *</Label>
                <Input id="emp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="col-span-2">
                <Label htmlFor="emp-pw">Password *</Label>
                <div className="flex gap-2">
                  <Input
                    id="emp-pw"
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button type="button" size="sm" variant="outline" onClick={() => setShowPw((v) => !v)} aria-label="Toggle password">
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-slate-400">Auto-generated — hand it to them; they can change it with “Forgot password”.</p>
              </div>
              <div>
                <Label htmlFor="emp-role">Role</Label>
                <Select id="emp-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="tech">Tech</option>
                  <option value="office">Office</option>
                  <option value="admin">Admin</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="emp-rate">Billable rate ($/hr)</Label>
                <NumberInput id="emp-rate" value={rate} onValueChange={setRate} />
              </div>
              <label className="col-span-2 flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={requireReset} onChange={(e) => setRequireReset(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                <span>Require a password reset on first login <span className="text-slate-400">— they use this password once, then set their own.</span></span>
              </label>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
