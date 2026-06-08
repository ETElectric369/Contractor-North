// Idempotent Google Maps JS loader (client-only). Loads the Maps JS API with
// the Places library once; subsequent calls resolve immediately.
let mapsPromise: Promise<void> | null = null;

export function loadGoogleMaps(key: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ((window as any).google?.maps) return Promise.resolve();
  if (!mapsPromise) {
    mapsPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      // No `loading=async` — that lazy-loads libraries, so google.maps.Map /
      // places.Autocomplete aren't ready when we use them synchronously. The
      // classic load resolves with all libraries available.
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
      s.async = true;
      s.onload = () => {
        // Defensive: wait a tick for google.maps to be defined.
        const ready = () => (window as any).google?.maps?.Map;
        if (ready()) return resolve();
        let tries = 0;
        const t = setInterval(() => {
          if (ready() || tries++ > 40) {
            clearInterval(t);
            ready() ? resolve() : reject(new Error("Google Maps did not initialize"));
          }
        }, 100);
      };
      s.onerror = () => reject(new Error("Google Maps script failed to load"));
      document.head.appendChild(s);
    });
  }
  return mapsPromise;
}
