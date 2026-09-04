"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * ONE TAP, ONE ACTION. A submit button that goes quiet while its form's server action is running.
 * Without this a second tap (or a slow first response) fires the action twice: logins were minting
 * two sessions a second apart, and a twice-fired sign-out is exactly what turns GoTrue's
 * "this device" logout into "every device" (see login/actions.ts signOut). Same look as Button.
 */
export function FormSubmit({ disabled, children, ...props }: React.ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" aria-busy={pending || undefined} disabled={pending || disabled} {...props}>
      {children}
    </Button>
  );
}
