import { headers } from "next/headers";
import { Smartphone, MapPin, Bell, Share } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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
export async function PhoneSetupChecklist() {
  const inShell = shellFromUserAgent((await headers()).get("user-agent")).native;
  return (
    <Card className="mb-4 border-sky-200 bg-sky-50/60">
      <CardContent className="py-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Smartphone className="h-4 w-4 text-sky-600" /> Set up your phone for North
        </div>
        <ol className="space-y-3 text-sm text-slate-700">
          {!inShell && (
            <li className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">1</span>
              <div>
                <div className="font-medium text-slate-900">
                  <Share className="mr-1 inline h-3.5 w-3.5 text-sky-600" /> Add North to your home screen
                </div>
                <div className="text-xs text-slate-600">
                  Open the site in Safari → tap the Share button → <span className="font-medium">Add to Home Screen</span>. Now it opens like an app.
                </div>
              </div>
            </li>
          )}
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">{inShell ? 1 : 2}</span>
            <div>
              <div className="font-medium text-slate-900">
                <MapPin className="mr-1 inline h-3.5 w-3.5 text-sky-600" /> Turn on Location
              </div>
              {inShell ? (
                <div className="text-xs text-slate-600">
                  iPhone <span className="font-medium">Settings → Privacy &amp; Security → Location Services → North → &ldquo;While Using the App.&rdquo;</span>{" "}
                  This powers GPS clock-in, job-site auto clock-out, the My&nbsp;Day weather, and mileage.
                </div>
              ) : (
                <div className="text-xs text-slate-600">
                  iPhone <span className="font-medium">Settings → Privacy &amp; Security → Location Services → Safari Websites → &ldquo;While Using the App.&rdquo;</span>{" "}
                  Look for <span className="font-medium">&ldquo;Safari Websites,&rdquo;</span> NOT &ldquo;North&rdquo; — an installed web app has no entry of its own.
                  This powers GPS clock-in, job-site auto clock-out, the My&nbsp;Day weather, and mileage.
                </div>
              )}
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">{inShell ? 2 : 3}</span>
            <div>
              <div className="font-medium text-slate-900">
                <Bell className="mr-1 inline h-3.5 w-3.5 text-sky-600" /> Allow Notifications
              </div>
              <div className="text-xs text-slate-600">
                When North asks, tap <span className="font-medium">Allow</span> — schedule reminders and clock-out prompts come through here.
              </div>
            </div>
          </li>
        </ol>
        {!inShell && (
          <p className="mt-3 text-xs text-slate-400">
            Android: it&rsquo;s the same idea — &ldquo;Add to Home screen&rdquo; in Chrome, then allow Location and Notifications when prompted.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
