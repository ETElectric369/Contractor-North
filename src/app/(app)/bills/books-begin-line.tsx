"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateShort } from "@/lib/utils";
import { setBooksBegin } from "./books-begin-actions";

/**
 * "SUPPLIER BILLS COUNT FROM JUN 8." The line a company's supplier cards are drawn from, said out
 * loud with the day it is, and a small Change for whoever can change company settings (Wave 0:
 * settings.books_begin; it was a constant for one company). Everyone else sees the sentence only.
 */
export function BooksBeginLine({ since, named, canChange }: { since: string | null; named: boolean; canChange: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [day, setDay] = useState(since ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save(next: string | null) {
    setError(null);
    start(async () => {
      const res = await setBooksBegin(next);
      if (!res.ok) return setError(res.error ?? "That didn't save.");
      setEditing(false);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <div className="mb-3 mt-1 space-y-2">
        <label htmlFor="books-begin" className="block text-xs text-slate-500">
          Supplier bills dated before this day never wait on you.
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input id="books-begin" type="date" className="h-11 w-44" value={day} onChange={(e) => setDay(e.target.value)} />
          <Button onClick={() => save(day || null)} disabled={pending || !day}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {named && (
            <Button variant="outline" onClick={() => save(null)} disabled={pending}>
              Use My First Bill
            </Button>
          )}
          <Button variant="ghost" onClick={() => { setEditing(false); setError(null); setDay(since ?? ""); }} disabled={pending}>
            Cancel
          </Button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <p className="mb-3 mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
      <span>{since ? `Supplier bills count from ${formatDateShort(since)}.` : "Every supplier bill counts."}</span>
      {canChange && (
        <button type="button" onClick={() => setEditing(true)} className="inline-flex min-h-11 items-center font-medium text-brand hover:underline">
          Change
        </button>
      )}
    </p>
  );
}
