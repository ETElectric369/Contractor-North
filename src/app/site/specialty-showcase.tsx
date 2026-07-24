import type { PortfolioPhoto } from "../estimate/[handle]/portfolio-gallery";
import { imageSrcSet, sizedImage } from "@/lib/site-image";

/**
 * SIGNATURE-SPECIALTY showcase — an elegant, dark "gallery moment" on the public homepage that
 * spotlights the one thing an org most wants to sell (e.g. custom lighting). Fully data-driven:
 * renders only when a headline is set, so orgs that don't configure it are unaffected.
 *
 * The first photo hangs as a framed centerpiece; the rest fall into a hairline-matted masonry that
 * preserves each image's TRUE proportion (natural h-auto sizing) so a hand-forged fixture or a tall
 * chandelier is never sliced — the one non-negotiable for artisan work. The deep-teal brand accent
 * only whispers: the header rule and the caption dots. Near-black warm charcoal lets the lighting
 * photography glow. (Art direction chosen by a 3-way design panel + judge.)
 */
export function SpecialtyShowcase({
  headline,
  blurb,
  brand,
  photos,
}: {
  headline: string;
  blurb: string;
  brand: string;
  photos: PortfolioPhoto[];
}) {
  if (!headline || !photos.length) return null;
  const [lead, ...rest] = photos;
  const hairline = "rgba(255,255,255,0.08)";

  // Museum-wall-label caption: an accent dot + a hairline rule + a serif-italic line. Rendered only
  // when a caption exists (the alt text still carries the description for SEO/accessibility).
  const Caption = ({ text }: { text?: string }) =>
    text ? (
      <figcaption className="mt-4 flex items-start gap-3 border-t pt-3" style={{ borderColor: hairline }}>
        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: brand }} aria-hidden />
        <span className="font-serif text-[13px] italic leading-snug text-neutral-300 sm:text-sm">{text}</span>
      </figcaption>
    ) : null;

  return (
    <section aria-label={headline} className="w-full overflow-hidden bg-[#0b0a09] text-neutral-200">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
        {/* Header — the exhibition label */}
        <header className="max-w-2xl">
          <div className="flex items-center gap-3">
            <span className="h-px w-8 shrink-0" style={{ backgroundColor: brand }} aria-hidden />
            <span className="text-[0.7rem] font-medium uppercase tracking-[0.32em] text-neutral-400">
              Signature work
            </span>
          </div>
          <h2 className="mt-6 font-serif text-3xl font-light leading-[1.1] tracking-tight text-neutral-50 sm:text-4xl md:text-5xl">
            {headline}
          </h2>
          {blurb && (
            <p className="mt-5 max-w-xl text-base font-light leading-relaxed text-neutral-400 sm:text-lg">{blurb}</p>
          )}
        </header>

        {/* Centerpiece — a framed landscape lead, height-capped (object-cover) so it never becomes a
            wall on desktop. Only the lead is cropped-to-frame; every masonry plate below stays whole. */}
        <figure className="mt-12 sm:mt-16">
          <div className="overflow-hidden border p-2 sm:p-3" style={{ borderColor: hairline }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sizedImage(lead.url, 1280)}
              srcSet={imageSrcSet(lead.url, [640, 1280, 1920])}
              sizes="(min-width: 1280px) 1152px, 100vw"
              alt={lead.caption || headline}
              loading="lazy"
              decoding="async"
              className="aspect-[16/10] w-full object-cover sm:aspect-[16/9]"
            />
          </div>
          <Caption text={lead.caption} />
        </figure>

        {/* The rest — a restrained masonry (1 column on phone, 2 on desktop). Natural h-auto sizing
            means each photo keeps its exact aspect ratio: zero crop, zero distortion, portrait or
            landscape. No running figure numbers (columns fill top-to-bottom, so a strict sequence
            would read out of order) — the dot + serif caption is label enough. */}
        {rest.length > 0 && (
          <div className="mt-12 sm:columns-2 sm:gap-8">
            {rest.map((p, i) => (
              <figure key={i} className="mb-10 break-inside-avoid sm:mb-8">
                <div className="overflow-hidden border p-2 sm:p-2.5" style={{ borderColor: hairline }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={sizedImage(p.url, 960)}
                    srcSet={imageSrcSet(p.url, [480, 960])}
                    sizes="(min-width: 640px) 50vw, 100vw"
                    alt={p.caption || headline}
                    loading="lazy"
                    decoding="async"
                    className="block h-auto w-full"
                  />
                </div>
                <Caption text={p.caption} />
              </figure>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
