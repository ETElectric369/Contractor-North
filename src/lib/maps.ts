// One source of truth for "navigate to an address" links. A `?q=` URL only drops
// a SEARCH PIN — it does not start guided navigation. `daddr=…&dirflg=d` opens
// Apple Maps driving directions (native turn-by-turn on iPhone, the owner's
// device). Centralized so no caller re-introduces a pin link.
export function navUrl(address: string): string {
  return `https://maps.apple.com/?daddr=${encodeURIComponent(address)}&dirflg=d`;
}
