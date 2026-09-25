import { Mail, Phone } from "lucide-react";
import { seaGlassStyle } from "./portal-format";

/**
 * THE CUSTOMER'S PAGES WEAR THE APP'S SEA GLASS (Erik, 2026-09-24: "an interactive UI with sea
 * glass"). The same tinted backdrop and frosted panels as the office's dock, in the org's own
 * glass color, with the org's name and logo on top. Phone first: one column, 16px gutters,
 * everything a finger touches at least 44px.
 */
export type PortalOrg = {
  name: string;
  logoUrl?: string | null;
  phone?: string | null;
  email?: string | null;
  license?: string | null;
  /** The org's glass color, "#rrggbb". */
  tint?: string | null;
};

export function PortalShell({ org, children, wide = false }: { org: PortalOrg; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="portal-backdrop min-h-dvh pb-12 text-slate-900" style={seaGlassStyle(org.tint)}>
      <div className={`mx-auto px-4 pt-4 sm:pt-8 ${wide ? "max-w-5xl" : "max-w-2xl"}`}>
        <PortalHeader org={org} />
        {children}
        <p className="mt-8 text-center text-sm text-slate-600">
          Questions? Ask {org.name}
          {org.phone ? (
            <>
              {" "}
              at{" "}
              <a className="font-medium text-[rgb(var(--glass-ink))] underline underline-offset-2" href={`tel:${org.phone.replace(/[^\d+]/g, "")}`}>
                {org.phone}
              </a>
            </>
          ) : null}
          .
        </p>
      </div>
    </div>
  );
}

function PortalHeader({ org }: { org: PortalOrg }) {
  const tel = org.phone ? org.phone.replace(/[^\d+]/g, "") : "";
  return (
    <header className="portal-glass glass-gloss mb-4 rounded-2xl px-4 py-3 sm:px-5 sm:py-4">
      <div className="relative z-10 flex flex-wrap items-center gap-3">
        {org.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logoUrl} alt="" className="h-11 w-auto max-w-[120px] shrink-0 rounded-lg bg-white object-contain p-1 shadow-sm" />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-bold leading-tight text-[rgb(var(--glass-ink))]">{org.name}</div>
          {org.license ? <div className="text-xs text-slate-600">{org.license}</div> : null}
        </div>
        <div className="flex gap-2">
          {tel ? (
            // On a phone the name gets the room: the buttons are 44px icons, named for a screen reader.
            <a
              href={`tel:${tel}`}
              aria-label={`Call ${org.name}`}
              className="seaglass-btn inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
            >
              <Phone className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Call</span>
            </a>
          ) : null}
          {org.email ? (
            <a
              href={`mailto:${org.email}`}
              aria-label={`Email ${org.name}`}
              className="seaglass-btn inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
            >
              <Mail className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Email</span>
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/** A link the office turned off or replaced. Plain words and who to ask; never a dead 404 for a
 *  customer who was sent this link on purpose. Nothing else from the account is shown. */
export function PortalTurnedOff({ orgName }: { orgName: string | null }) {
  return (
    <div className="portal-backdrop min-h-dvh py-16" style={seaGlassStyle(null)}>
      <div className="mx-auto max-w-md px-4">
        <div className="portal-glass rounded-2xl px-6 py-10 text-center">
          <p className="text-base font-medium text-slate-900">
            This link was turned off. Ask {orgName || "the business that sent it"} for a new one.
          </p>
        </div>
      </div>
    </div>
  );
}

/** A plain one-panel message (the page isn't ready, or couldn't load). */
export function PortalNotice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="portal-backdrop min-h-dvh py-16" style={seaGlassStyle(null)}>
      <div className="mx-auto max-w-md px-4">
        <div className="portal-glass rounded-2xl px-6 py-10 text-center">
          <h1 className="text-base font-semibold text-slate-900">{title}</h1>
          {children ? <div className="mt-2 text-sm text-slate-600">{children}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** A glass section with a heading, the anchor the page's section chips jump to. */
export function PortalSection({
  id,
  title,
  icon,
  aside,
  children,
}: {
  id: string;
  title: string;
  icon?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="mt-6 scroll-mt-20">
      <div className="mb-2 flex items-end justify-between gap-2 px-1">
        <h2 id={`${id}-h`} className="flex items-center gap-2 text-base font-semibold text-slate-900">
          {icon ? <span className="text-[rgb(var(--glass-ink))]" aria-hidden>{icon}</span> : null}
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
