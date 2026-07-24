import Link from "next/link";

/**
 * Branded 404 for every public org-site route (by-domain + [handle]). Before this, an
 * unknown URL 307'd to the homepage — Google's textbook soft-404, which both masks broken
 * links and keeps dead URLs in the crawl queue forever (Tahoe Deck SEO audit 2026-07-24).
 * A real 404 status with a way home is what search engines and visitors both want. Kept
 * org-agnostic (a not-found boundary receives no params); "/" resolves to the org's own
 * homepage on its domain.
 */
export default function SiteNotFound() {
  return (
    <div style={{ minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <p style={{ fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase", color: "#94a3b8", fontWeight: 700, margin: 0 }}>404</p>
        <h1 style={{ fontSize: 24, margin: "8px 0 8px", color: "#0f172a" }}>That page isn&apos;t here</h1>
        <p style={{ color: "#64748b", fontSize: 15, margin: "0 0 20px" }}>
          It may have moved or never existed. The homepage has everything current.
        </p>
        <Link href="/" style={{ display: "inline-block", background: "#0f172a", color: "#fff", padding: "10px 22px", borderRadius: 10, textDecoration: "none", fontWeight: 600, fontSize: 14 }}>
          Go to the homepage
        </Link>
      </div>
    </div>
  );
}
