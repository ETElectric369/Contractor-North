"use client";

import { useEffect, useState } from "react";
import { orgPublicBase } from "@/app/(app)/share-actions";

/**
 * The business's own public base URL ("https://etelectricity.com"), for client components that
 * render a customer-facing link into an `sms:` href or a clipboard copy at paint time.
 *
 * Replaces `window.location.origin`, which three of these components used to build the CUSTOMER's
 * link out of the STAFF member's current host. Wrong, and worse, non-deterministic: the same
 * "pick a time" button produced app.contractornorth.com, a vercel.app preview or localhost
 * depending on where the office was signed in, so one customer's text thread and their email
 * could carry two different domains for the same appointment.
 *
 * Returns "" until it resolves. Callers already treat a falsy base as "no link yet" and hide the
 * button, which is the correct behaviour for the half-second before it lands — a link built on an
 * empty base would be a relative URL in a text message, i.e. nothing at all.
 */
export function useOrgPublicBase(): string {
  const [base, setBase] = useState("");
  useEffect(() => {
    let alive = true;
    orgPublicBase()
      .then((b) => {
        if (alive) setBase(b);
      })
      .catch(() => {
        /* leave it empty — the caller hides the link rather than sending a broken one */
      });
    return () => {
      alive = false;
    };
  }, []);
  return base;
}
