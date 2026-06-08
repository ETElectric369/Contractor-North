// Idempotent Google Maps JS loader (client-only). Loads the Maps JS API with
// the Places library once; subsequent calls resolve immediately.
let mapsPromise: Promise<void> | null = null;

export function loadGoogleMaps(key: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ((window as any).google?.maps) return Promise.resolve();
  if (!mapsPromise) {
    mapsPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&loading=async`;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Google Maps failed to load"));
      document.head.appendChild(s);
    });
  }
  return mapsPromise;
}
