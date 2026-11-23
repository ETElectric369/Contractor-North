import Link from "next/link";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { shellFromUserAgent } from "@/lib/native-shell";
import { NO_INDEX } from "@/lib/no-index";
import { fillText, localeOf, translator } from "@/lib/i18n";
import { langFromAcceptLanguage } from "@/lib/request-lang";
import { createClient } from "@/lib/supabase/server";
import { cleanInviteToken, decideInviteDoor, inviteJoinPath, joinErrorKey, type InviteDoorState } from "@/lib/invite-door";
import { readInviteDoor } from "@/lib/invite-door-read";
import { FormSubmit } from "@/components/form-submit";
import { Input, Label } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { signOut } from "@/app/login/actions";
import { joinWithInvite, joinSignedIn } from "./actions";

/**
 * THE ONE-STEP INVITE'S PAGE (cn-v1183): where the invite email's link lands.
 *
 * GET CHANGES NOTHING: mail scanners and link previewers fetch this page before the person taps, so
 * it only reads (the invitation by its token, the session if there is one) and draws ONE state. The
 * deed is the form's POST (./actions), which reads and decides again and never trusts this render.
 * The token is checked for its shape before any read. Nobody may have a session here, so the words
 * are the phone's (Accept-Language), the same rule as the sign-in page, and it looks like that page.
 * Every state names its one way forward: nothing silent, no dead end.
 */
export const dynamic = "force-dynamic";

async function pageLang() {
  return langFromAcceptLanguage((await headers()).get("accept-language"));
}

/** Who is signed in on this phone, if anyone: the email and their company. A failed read is no session. */
async function readSession(): Promise<{ email: string | null; orgId: string | null } | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data: me } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
    return { email: user.email ?? null, orgId: (me as { org_id?: string | null } | null)?.org_id ?? null };
  } catch {
    return null;
  }
}

export default async function JoinPage({ searchParams }: { searchParams: Promise<{ t?: string; e?: string }> }) {
  const { t: rawToken, e: errorCode } = await searchParams;
  const h = await headers();
  const lang = langFromAcceptLanguage(h.get("accept-language"));
  const t = translator(lang);
  // NO FREE TEXT FROM THE URL IS DRAWN (fixer #85, F6): the door sends back a CODE, and only a known
  // code becomes its catalog sentence. Anyone can craft a link to this page; an unknown code draws nothing.
  const errorKey = joinErrorKey(errorCode);
  const error = errorKey ? t(errorKey) : null;
  const shell = shellFromUserAgent(h.get("user-agent")).native;

  const token = cleanInviteToken(rawToken);
  let state: InviteDoorState | { kind: "unavailable" } = { kind: "invalid" };
  let company = "";
  let inviteEmail = "";
  let role = "tech";
  if (token) {
    const read = await readInviteDoor(token);
    if (!read.ok) {
      state = { kind: "unavailable" };
    } else {
      const session = read.invite ? await readSession() : null;
      state = decideInviteDoor({
        invite: read.invite,
        now: new Date(),
        shell,
        session,
        account: read.account,
        newerElsewhere: read.newerElsewhere,
      });
      company = read.orgName;
      inviteEmail = read.invite?.email ?? "";
      role = read.invite?.role ?? "tech";
    }
  }
  if (state.kind === "member") redirect("/planner");

  const co = company || t("au_joinYourTeam");
  const roleWord = t(role === "admin" ? "au_joinRole_admin" : role === "office" ? "au_joinRole_office" : "au_joinRole_tech");
  const signInHref = token && inviteEmail
    ? `/login?email=${encodeURIComponent(inviteEmail)}&next=${encodeURIComponent(inviteJoinPath(token))}`
    : "/login";
  const signInLink = (
    <Link href={signInHref} className="font-medium text-brand hover:underline">
      {t("au_signIn")}
    </Link>
  );
  const line = (text: string) => <p className="text-sm text-slate-600">{text}</p>;

  let heading = t("au_joinTitle");
  let body: ReactNode;
  switch (state.kind) {
    case "create":
      heading = fillText(t("au_joinHeading"), { company: co });
      body = (
        <form className="space-y-4">
          <p className="text-sm text-slate-500">{fillText(t("au_joinSub"), { role: roleWord })}</p>
          <p className="text-sm text-slate-700">{fillText(t("au_joinEmailLine"), { email: inviteEmail })}</p>
          <input type="hidden" name="t" value={token ?? ""} />
          <div>
            <Label htmlFor="full_name">{t("au_fullName")}</Label>
            <Input id="full_name" name="full_name" autoComplete="name" maxLength={120} placeholder={t("au_fullNamePlaceholder")} required />
          </div>
          <div>
            <Label htmlFor="password">{t("au_password")}</Label>
            <PasswordInput id="password" name="password" autoComplete="new-password" placeholder="••••••••" required minLength={6} />
          </div>
          <FormSubmit className="w-full" size="lg" formAction={joinWithInvite}>
            {fillText(t("au_joinButton"), { company: co })}
          </FormSubmit>
        </form>
      );
      break;
    case "join_signed_in":
      heading = fillText(t("au_joinHeading"), { company: co });
      body = (
        <form className="space-y-4">
          {line(fillText(t("au_joinSignedIn"), { company: co, role: roleWord }))}
          <input type="hidden" name="t" value={token ?? ""} />
          <FormSubmit className="w-full" size="lg" formAction={joinSignedIn}>
            {fillText(t("au_joinButton"), { company: co })}
          </FormSubmit>
        </form>
      );
      break;
    case "sign_in_first":
      body = (
        <div className="space-y-4">
          {line(fillText(t("au_joinSignInFirst"), { company: co }))}
          <p className="text-center text-sm">{signInLink}</p>
        </div>
      );
      break;
    case "shell":
      body = (
        <div className="space-y-4">
          {line(t("au_shellSignupNote"))}
          <p className="text-center text-sm">{signInLink}</p>
        </div>
      );
      break;
    case "used":
      body = (
        <div className="space-y-4">
          {line(fillText(t("au_joinUsed"), { company: co }))}
          <p className="text-center text-sm">
            <Link href="/login" className="font-medium text-brand hover:underline">
              {t("au_signIn")}
            </Link>
          </p>
        </div>
      );
      break;
    case "expired": {
      const date = new Date(state.expiresAt).toLocaleDateString(localeOf(lang), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      body = line(fillText(t("au_joinExpired"), { date, company: co }));
      break;
    }
    case "superseded":
      body = line(fillText(t("au_joinSuperseded"), { company: co }));
      break;
    case "signed_in_other":
      body = (
        <form className="space-y-4">
          {line(fillText(t("au_joinSignedInOther"), { email: state.sessionEmail }))}
          <FormSubmit className="w-full" size="lg" variant="outline" formAction={signOut}>
            {t("sh_signOut")}
          </FormSubmit>
        </form>
      );
      break;
    case "other_company":
      body = line(fillText(t("au_joinOtherCompany"), { company: co }));
      break;
    case "unavailable":
      body = line(t("au_joinUnavailable"));
      break;
    default:
      body = line(t("au_joinInvalid"));
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4 pt-[var(--sat,0px)]">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-192.png" alt={t("au_appName")} className="mx-auto mb-3 h-16 w-16 rounded-2xl shadow-lg ring-1 ring-white/15" />
          <h1 className="text-2xl font-bold tracking-tight">{t("au_appName")}</h1>
          <p className="mt-1 text-sm text-white/80">{t("au_tagline")}</p>
        </div>
        <div className="rounded-2xl bg-white p-8 shadow-xl">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">{heading}</h2>
          {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
          {body}
        </div>
      </div>
    </div>
  );
}

// Never indexed, and never a Referer: the address bar holds the invitation's token.
export async function generateMetadata() {
  return { title: translator(await pageLang())("au_joinTitle"), robots: NO_INDEX, referrer: "no-referrer" as const };
}
