import { Container } from "@/components/ui/Container";
import { Section } from "@/components/ui/Section";

const logos = ["Northwind", "Acme Corp", "Globex", "Initech", "Umbra", "Soylent"];

const testimonial = {
  quote:
    "Crest Meet replaced three tools for our revenue team. The cross-meeting chat alone saves me an hour of scrolling through recordings every week.",
  author: "Priya N.",
  role: "Head of Revenue Operations",
  company: "Northwind",
};

export function SocialProof() {
  return (
    <Section id="customers">
      <Container>
        {/* T2 — logo wall, hairline, monochrome, gentle marquee */}
        <p className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Trusted by modern revenue, product, and research teams
        </p>
        <div className="relative mt-8 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
          <div className="flex w-max items-center gap-12 hall-marquee">
            {[...logos, ...logos].map((name, i) => (
              <span
                key={i}
                className="font-display text-xl font-bold text-ink-mute"
                aria-hidden={i >= logos.length}
              >
                {name}
              </span>
            ))}
          </div>
        </div>

        {/* T1 — pull quote with marginalia */}
        <div className="mx-auto mt-16 grid max-w-4xl gap-2 md:grid-cols-[1fr_auto] md:gap-10">
          <figure className="border-l-2 border-brand-600 pl-6">
            <blockquote className="text-xl font-medium leading-relaxed text-ink sm:text-2xl">
              “{testimonial.quote}”
            </blockquote>
          </figure>
          <figcaption className="md:border-l md:border-border md:pl-6 md:text-right">
            <p className="font-semibold text-ink">{testimonial.author}</p>
            <p className="text-sm text-ink-mute">{testimonial.role}</p>
            <p className="text-sm text-ink-faint">{testimonial.company}</p>
          </figcaption>
        </div>
      </Container>
    </Section>
  );
}
