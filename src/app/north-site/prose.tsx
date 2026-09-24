/** Shared pieces for the text pages (/support, /privacy): one headline shape, one section shape. */

export function PageHead({ eyebrow, first, second, children }: {
  eyebrow: string;
  first: string;
  second: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="pb-4 pt-12 sm:pt-16">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1b9488]">{eyebrow}</p>
      <h1 className="mt-4 max-w-3xl font-[family-name:var(--font-north-serif)] text-[28px] font-semibold leading-[1.14] tracking-tight sm:text-[40px]">
        {first}
        <span aria-hidden className="block h-[0.5em]" />
        <span className="block text-[#51607a]">{second}</span>
      </h1>
      {children}
    </div>
  );
}

export function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 border-t border-[#d9dde5] py-7 lg:grid lg:grid-cols-12 lg:gap-x-10">
      <h2 className="font-[family-name:var(--font-north-serif)] text-[21px] font-semibold leading-snug lg:col-span-4">{title}</h2>
      <div className="mt-3 max-w-2xl space-y-3 text-[15.5px] leading-relaxed text-[#33425e] lg:col-span-8 lg:mt-0 [&_a]:font-medium [&_a]:text-[#1a2b4a] [&_a]:underline [&_a]:decoration-[#1b9488] [&_a]:underline-offset-2 [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-[#1a2b4a] [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}
