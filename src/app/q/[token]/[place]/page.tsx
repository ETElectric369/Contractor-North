/**
 * /q/<token>/<place> — the same estimate page. The place ("13897-herringbone", lib/doc-place) is
 * there for the person reading the link and is IGNORED here: the token alone is the key, so a
 * street that changes later breaks nothing, and /q/<token> still opens as it always has.
 */
export { default, generateMetadata } from "../page";

export const dynamic = "force-dynamic";
