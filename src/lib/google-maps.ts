// Idempotent Google Maps JS loader (client-only). Loads the Maps JS API with
// the Places library once; subsequent calls resolve immediately.
let mapsPromise: Promise<void> | null = null;

/**
 * One-way driving distance in miles between two addresses via the Directions
 * service. Returns null if it can't be computed. Client-only.
 */
export async function drivingDistanceMiles(
  key: string,
  origin: string,
  destination: string,
): Promise<number | null> {
  if (typeof window === "undefined" || !origin || !destination) return null;
  await loadGoogleMaps(key);
  const g = (window as any).google;
  if (!g?.maps) return null;
  const svc = new g.maps.DirectionsService();
  return new Promise((resolve) => {
    svc.route(
      { origin, destination, travelMode: g.maps.TravelMode.DRIVING },
      (res: any, status: string) => {
        if (status === "OK" && res?.routes?.[0]?.legs?.length) {
          const meters = res.routes[0].legs.reduce(
            (s: number, l: any) => s + (l.distance?.value || 0),
            0,
          );
          resolve(meters / 1609.344);
        } else {
          resolve(null);
        }
      },
    );
  });
}

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
