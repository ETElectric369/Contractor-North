import type { WordCatalog } from "./types";

/**
 * THE GEOFENCE'S WORDS (gf_): the leave-the-site sheet and its buttons, the idle line about location
 * (off, not asked yet, While Using, no region monitor, no anchor), the spoken and lock-screen
 * confirmations, the server's "Clock out?" push, and the shell's compiled "Still on the clock?"
 * notification (GeofencePlugin.swift keeps today's English only as the fallback: the page now arms
 * the fence with the title and body in the person's language). The English is byte-for-byte what
 * the code said before cn-v1138; a {slot} is filled by fillText. Buttons are Title Case in both
 * languages; sentences keep sentence case.
 */
export const words: WordCatalog = {
  prefix: "gf_",
  files: ["src/components/geofence-monitor.tsx", "src/lib/native-geofence.ts", "src/components/geofence-fallback.ts"],
  sameInBoth: [],
  en: {
    gf_theJobSite: "the job site",
    // The server's push (notifyGeofenceExit) and the shell's own alert, which rings with the screen off.
    gf_clockOutQ: "Clock out?",
    gf_looksLikeYouLeftStillOn: "Looks like you left {label} — you're still on the clock.",
    gf_stillOnTheClock: "Still on the clock?",
    gf_looksLikeYouLeft: "Looks like you left {label}. Open North to clock out or keep going.",
    // The idle line.
    gf_locationOffForApp: "Location is off for this app, so I can’t offer to clock you out when you leave. Clock out yourself, or turn location back on in Settings.",
    gf_locationNotOnYet: "Location isn’t on yet for North, so I can’t notice when you leave {label}.",
    gf_turnOnLocation: "Turn On Location",
    gf_phoneCantWatchScreenOff: "This phone can’t watch the job site with the screen off, so I’ll only notice you leaving while North is open.",
    gf_locationOffForNorth: "Location is off for North, so I can’t notice you leaving the job site with the screen off. Turn it on in Settings, under Location Services, North, Always.",
    gf_locationWhileUsing: "Location for North is set to While Using, so I can’t notice you leaving the job site with the screen off. Set it to Always in Settings, under Location Services, North.",
    gf_couldntGetLocationAt: "I couldn’t get a location at {label}, so I can’t offer to clock you out when you leave this job. Clock out yourself when you’re done.",
    gf_phoneDidntAnswerInTime: "The phone didn’t answer with a location in time. Try again.",
    gf_phoneCouldntGiveLocation: "This phone couldn’t give a location just now. Try again.",
    // The close and its answers.
    gf_couldNotClockOut: "Could not clock out — try again.",
    gf_noConnectionUntouched: "No connection — your shift is untouched, try again.",
    gf_clockedOutYouLeftSpoken: "Clocked out — you left the job site.",
    gf_clockedOutYouLeftTitle: "Clocked out — you left the job site",
    gf_tapToFinishTimecard: "Tap to finish your timecard.",
    gf_clockedOutAtYouLeft: "Clocked out at {time} — you left {label}.",
    gf_finishYourTimecard: "Finish Your Timecard →",
    // The sheet.
    gf_looksLikeYouLeftClockOut: "Looks like you left {label}. Clock out?",
    gf_stillOnClockPickTime: "You're still on the clock. Left a while ago with the app closed? Pick the time you actually left.",
    gf_noAnswer5MinPicking: "No answer in 5 minutes? We'll clock you out at {at}, when you were last at the site.",
    gf_noAnswerClockOutAt: "No answer? We'll clock you out at {at}.",
    gf_pickWhenYouLeft: "Pick when you actually left.",
    gf_clockingOutAtTimeAbove: "Clocking out at the time above. Pick when you actually left.",
    gf_back: "Back",
    gf_stillWorking: "Still Working",
    gf_clockOutNow: "Clock Out Now",
    gf_pickTheTime: "Pick The Time…",
  },
  es: {
    gf_theJobSite: "el sitio de trabajo",
    gf_clockOutQ: "¿Marcar salida?",
    gf_looksLikeYouLeftStillOn: "Parece que saliste de {label} — sigues en el reloj.",
    gf_stillOnTheClock: "¿Sigues en el reloj?",
    gf_looksLikeYouLeft: "Parece que saliste de {label}. Abre North para marcar salida o seguir trabajando.",
    gf_locationOffForApp: "La ubicación está apagada para esta app, así que no puedo ofrecerte marcar salida cuando te vayas. Marca salida por tu cuenta, o vuelve a encender la ubicación en Configuración.",
    gf_locationNotOnYet: "La ubicación todavía no está activada para North, así que no puedo notar cuando salgas de {label}.",
    gf_turnOnLocation: "Activar Ubicación",
    gf_phoneCantWatchScreenOff: "Este teléfono no puede vigilar el sitio de trabajo con la pantalla apagada, así que solo notaré que te vas mientras North esté abierta.",
    gf_locationOffForNorth: "La ubicación está apagada para North, así que no puedo notar que sales del sitio de trabajo con la pantalla apagada. Enciéndela en Configuración, en Localización, North, Siempre.",
    gf_locationWhileUsing: "La ubicación de North está en Al usar la app, así que no puedo notar que sales del sitio de trabajo con la pantalla apagada. Ponla en Siempre en Configuración, en Localización, North.",
    gf_couldntGetLocationAt: "No pude obtener una ubicación en {label}, así que no puedo ofrecerte marcar salida cuando te vayas de este trabajo. Marca salida por tu cuenta cuando termines.",
    gf_phoneDidntAnswerInTime: "El teléfono no respondió con una ubicación a tiempo. Inténtalo de nuevo.",
    gf_phoneCouldntGiveLocation: "Este teléfono no pudo dar una ubicación ahora. Inténtalo de nuevo.",
    gf_couldNotClockOut: "No se pudo marcar salida — inténtalo de nuevo.",
    gf_noConnectionUntouched: "Sin conexión — tu turno sigue igual, inténtalo de nuevo.",
    gf_clockedOutYouLeftSpoken: "Salida marcada — saliste del sitio de trabajo.",
    gf_clockedOutYouLeftTitle: "Salida marcada — saliste del sitio de trabajo",
    gf_tapToFinishTimecard: "Toca para terminar tu tarjeta de tiempo.",
    gf_clockedOutAtYouLeft: "Salida marcada a las {time} — saliste de {label}.",
    gf_finishYourTimecard: "Terminar Tu Tarjeta De Tiempo →",
    gf_looksLikeYouLeftClockOut: "Parece que saliste de {label}. ¿Marcar salida?",
    gf_stillOnClockPickTime: "Sigues en el reloj. ¿Te fuiste hace rato con la app cerrada? Elige la hora en que saliste en realidad.",
    gf_noAnswer5MinPicking: "¿Sin respuesta en 5 minutos? Te marcaremos salida a las {at}, la última vez que estuviste en el sitio.",
    gf_noAnswerClockOutAt: "¿Sin respuesta? Te marcaremos salida a las {at}.",
    gf_pickWhenYouLeft: "Elige cuándo saliste en realidad.",
    gf_clockingOutAtTimeAbove: "Marcando salida a la hora de arriba. Elige cuándo saliste en realidad.",
    gf_back: "Atrás",
    gf_stillWorking: "Sigo Trabajando",
    gf_clockOutNow: "Marcar Salida Ahora",
    gf_pickTheTime: "Elegir La Hora…",
  },
};
