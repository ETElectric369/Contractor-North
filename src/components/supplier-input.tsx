"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { didYouMeanSupplier, type KnownSupplier } from "@/lib/supplier-suggest";
import { listKnownSuppliers } from "@/app/(app)/bills/known-suppliers-action";

/** One read per page, shared by every supplier box on it, started by the first box focused. */
let cache: Promise<KnownSupplier[]> | null = null;
const loadKnown = () => (cache ??= listKnownSuppliers().catch(() => [] as KnownSupplier[]));

/** The known suppliers, once a box has been focused; null until then. */
export function useKnownSuppliers(wanted: boolean): KnownSupplier[] | null {
  const [known, setKnown] = useState<KnownSupplier[] | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    loadKnown().then((k) => {
      if (live) setKnown(k);
    });
    return () => {
      live = false;
    };
  }, [wanted]);
  return known;
}

/**
 * THE SUPPLIER BOX (item D, 2026-10-07): a plain Input that, once focused, knows the company's
 * suppliers and asks "Did you mean X?" under itself when what is typed looks like one - with a Use
 * X button a thumb tall. Nothing is written for him: the server keeps an EXACT known spelling as
 * the supplier's one name (snapSupplierSpelling) and stores anything else as typed. `quiet` keeps
 * the box silent where the word may not be a supplier at all (a business cost's Who You Pay, which
 * can hold a landlord or a bucket word).
 */
export function SupplierInput({
  value,
  onValueChange,
  quiet = false,
  onFocus,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onValueChange: (value: string) => void; quiet?: boolean }) {
  const [touched, setTouched] = useState(false);
  const known = useKnownSuppliers(touched && !quiet);
  const hint = !quiet && known && !rest.disabled ? didYouMeanSupplier(value, known) : null;
  return (
    <div>
      <Input
        {...rest}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onFocus={(e) => {
          setTouched(true);
          onFocus?.(e);
        }}
      />
      {hint && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600" role="status">
          {"name" in hint ? (
            <>
              <span>
                Did you mean <span className="font-medium text-slate-900">{hint.name}</span>? {hint.why}
              </span>
              <button type="button" onClick={() => onValueChange(hint.name)} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-900 hover:bg-slate-50">
                Use {hint.name}
              </button>
            </>
          ) : (
            <>
              <span>Did you mean one of these?</span>
              {hint.choices.map((c) => (
                <button key={c} type="button" onClick={() => onValueChange(c)} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-900 hover:bg-slate-50">
                  Use {c}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
