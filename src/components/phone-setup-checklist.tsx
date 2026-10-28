import { headers } from "next/headers";
import { Smartphone, MapPin, Bell, Share } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { fillNodes } from "@/components/fill-nodes";
import { translator } from "@/lib/i18n";
import { shellFromUserAgent } from "@/lib/native-shell";

/**
 * App-managed "set up your phone for North" checklist (shown on the Handbook so every crew member sees
 * it; not part of the org's editable handbook text). The Location step is the one that trips everyone up:
 * an installed iOS web app rides under Settings → "Safari Websites" for location — it has NO entry of its
 * own — so if Safari Websites location is Never/Off, GPS clock-in, geofence, weather + mileage all silently
 * fail.
 *
 * Inside the native shell the coaching CHANGES (audit v921): there is nothing to add to the home screen —
 * the app is already installed — and telling an App Store user to open the site in Safari both reads as
 * "this is a website" (guideline 4.2 optics) and is wrong, because the shell has its own Settings entry
 * for Location instead of riding under "Safari Websites".
 */
export async function PhoneSetupChecklist({ lang }: { lang?: string | null } = {}) {
  const inShell = shellFromUserAgent((await headers()).get("user-agent")).native;
  // The words in the person's language (cn-v1138): the Handbook page hands over profiles.language.
  // The iPhone paths are what a Spanish iPhone's own Settings say, not a translation of the English.
  const t = translator(lang);
  const bold = (text: string) => <span className="font-medium">{text}</span>;
  return (
    <Card className="mb-4 border-sky-200 bg-sky-50/60">
      <CardContent className="py-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Smartphone className="h-4 w-4 text-sky-600" /> {t("sh_phoneSetupTitle")}
        </div>
        <ol className="space-y-3 text-sm text-slate-700">
          {!inShell && (
            <li className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">1</span>
              <div>
                <div className="font-medium text-slate-900">
                  <Share className="mr-1 inline h-3.5 w-3.5 text-sky-600" /> {t("sh_phoneAddHome")}
                </div>
                <div className="text-xs text-slate-600">{fillNodes(t("sh_phoneAddHomeHow"), { add: bold(t("sh_phoneAddToHome")) })}</div>
              </div>
            </li>
          )}
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">{inShell ? 1 : 2}</span>
            <div>
              <div className="font-medium text-slate-900">
                <MapPin className="mr-1 inline h-3.5 w-3.5 text-sky-600" /> {t("sh_phoneTurnOnLocation")}
              </div>
              {inShell ? (
                <div className="text-xs text-slate-600">{fillNodes(t("sh_phoneLocationShell"), { path: bold(t("sh_phonePathShell")) })}</div>
              ) : (
                <div className="text-xs text-slate-600">
                  {fillNodes(t("sh_phoneLocationWeb"), { path: bold(t("sh_phonePathWeb")), safari: bold(t("sh_phoneSafariWebsites")) })}
                </div>
              )}
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">{inShell ? 2 : 3}</span>
            <div>
              <div className="font-medium text-slate-900">
                <Bell className="mr-1 inline h-3.5 w-3.5 text-sky-600" /> {t("sh_phoneAllowNotifications")}
              </div>
              <div className="text-xs text-slate-600">{fillNodes(t("sh_phoneAllowHow"), { allow: bold(t("sh_phoneAllow")) })}</div>
            </div>
          </li>
        </ol>
        {!inShell && <p className="mt-3 text-xs text-slate-400">{t("sh_phoneAndroid")}</p>}
      </CardContent>
    </Card>
  );
}
