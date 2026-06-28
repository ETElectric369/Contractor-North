/**
 * Module-level speech-recognition service for the assistant.
 *
 * THE BUG it fixes: iOS Safari / home-screen PWAs reject SpeechRecognition.start() unless it runs INSIDE
 * a user gesture (a tap). The assistant used to start the mic from a post-mount useEffect (first open) and
 * from TTS "speech ended" callbacks (re-listen) — both run AFTER the gesture window closed, so on iPhone
 * the mic just never started. Because the recognizer was owned by <AssistantChat>, which isn't even
 * mounted at the first tap, there was no way to start it in-gesture from the topbar button.
 *
 * This holds the recognizer at MODULE level so the topbar tap (global-assistant launch()) can call
 * startListening() SYNCHRONOUSLY, in-gesture, before the chat panel mounts. The panel, once mounted,
 * registers the result handler and subscribes to the listening state. Off-gesture re-listen (desktop is
 * fine; iOS rejects) returns false so the caller can fall back to "tap Talk to speak".
 */

type ResultCb = (text: string) => void;
type StateCb = (listening: boolean) => void;

let recog: any = null;
let listeningNow = false;
let handler: ResultCb | null = null;
const stateSubs = new Set<StateCb>();

function getSR(): any {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

export function speechSupported(): boolean {
  return !!getSR();
}

export function isListening(): boolean {
  return listeningNow;
}

/** Subscribe to listening on/off (drives the mic UI + the topbar red-stop). Returns an unsubscribe. */
export function onListeningState(cb: StateCb): () => void {
  stateSubs.add(cb);
  return () => {
    stateSubs.delete(cb);
  };
}

function emit() {
  stateSubs.forEach((f) => {
    try {
      f(listeningNow);
    } catch {
      /* ignore a bad subscriber */
    }
  });
}

/**
 * Who receives the next final transcript. The chat sets this to "send as a spoken turn" normally, and
 * swaps it to a yes/no parser while a confirm proposal is pending. It's module-level so a transcript
 * captured after a launch()-started listen still has somewhere to go once the panel mounts.
 */
export function setResultHandler(cb: ResultCb | null) {
  handler = cb;
}

/**
 * START THE MIC. MUST be called inside a user gesture (a tap) to work on iOS. Returns false when speech
 * isn't supported OR start() threw (the off-gesture rejection), so the caller can show "tap Talk to speak".
 */
export function startListening(lang = "en-US"): boolean {
  const SR = getSR();
  if (!SR) return false;
  try {
    recog?.stop();
  } catch {
    /* ignore — replacing it anyway */
  }
  try {
    const r = new SR();
    r.continuous = false;
    r.interimResults = false;
    r.lang = lang;
    r.onresult = (e: any) => {
      let t = "";
      for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
      t = t.trim();
      if (t && handler) handler(t);
    };
    r.onerror = () => {
      listeningNow = false;
      emit();
    };
    r.onend = () => {
      listeningNow = false;
      emit();
    };
    r.start();
    recog = r;
    listeningNow = true;
    emit();
    return true;
  } catch {
    listeningNow = false;
    emit();
    return false;
  }
}

export function stopListening() {
  try {
    recog?.stop();
  } catch {
    /* ignore */
  }
  listeningNow = false;
  emit();
}
