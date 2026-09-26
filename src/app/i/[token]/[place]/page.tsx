/**
 * /i/<token>/<place> — the same invoice page. The place ("235-timbercreek", lib/doc-place) is
 * there for the person reading the link and is IGNORED here: the token alone is the key, so a
 * street that changes later breaks nothing, and /i/<token> still opens as it always has.
 */
export { default, generateMetadata } from "../page";

export const dynamic = "force-dynamic";
