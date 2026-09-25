import { notFound } from "next/navigation";
import type { PortalAccess } from "@/lib/portal/access";
import { PortalNotice, PortalTurnedOff } from "@/components/portal/portal-shell";
import { PortalSignIn, PortalSignOut } from "@/components/portal/portal-sign-in";
import { checkPortalCode, sendPortalCode, signOutPortal } from "./actions";

/**
 * THE FRONT DOOR OF EVERY PORTAL PAGE (0331). A page calls readPortalAccess(token) and then this,
 * before it reads anything of the customer's: anything but "in" renders here and the page stops.
 * The actions are bound to this link's token, so the sign-in screen never names one itself.
 */
export function portalGate(access: PortalAccess, token: string): React.ReactNode | null {
  switch (access.kind) {
    case "in":
      return null;
    case "missing":
      return notFound();
    case "off":
      return <PortalTurnedOff orgName={access.orgName} />;
    case "not_ready":
      return (
        <PortalNotice title="This page isn't ready yet.">
          Your contractor is setting it up. Try the link again later, or give them a call.
        </PortalNotice>
      );
    case "error":
      return (
        <PortalNotice title="This page couldn't load just now.">
          Pull down or reload to try again in a minute.
        </PortalNotice>
      );
    case "gate":
      return (
        <PortalSignIn
          org={access.org}
          maskedEmail={access.maskedEmail}
          send={sendPortalCode.bind(null, token)}
          check={checkPortalCode.bind(null, token)}
        />
      );
  }
}

/** The page title while the door is shut: never a job's or a customer's name. */
export function gateTitle(access: PortalAccess): string | null {
  if (access.kind === "off") return `${access.orgName ? `${access.orgName} — ` : ""}Link turned off`;
  if (access.kind === "gate") return `${access.org.name} — Sign in`;
  if (access.kind === "in") return null;
  return "Your account";
}

/** Sign Out On This Device, for a customer's own session (the office's look has nothing to sign out of). */
export function portalSignOut(access: PortalAccess, token: string): React.ReactNode {
  return access.kind === "in" && access.session === "customer" ? <PortalSignOut signOut={signOutPortal.bind(null, token)} /> : null;
}
