import { NO_INDEX } from "@/lib/no-index";

// Print views render customer documents (invoices, quotes, work orders) at guessable-looking
// paths — robots.txt Disallow alone can still leave them indexed URL-only from an inbound
// link. This segment layout stamps the authoritative noindex on all seven print routes at
// once (the "both layers, always" doctrine in lib/no-index.ts).
export const metadata = { title: "Print", robots: NO_INDEX };

export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return children;
}
