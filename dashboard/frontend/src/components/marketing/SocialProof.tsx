import { Container } from "@/components/ui/Container";
import { Section } from "@/components/ui/Section";

const logos = ["Northwind", "Acme Corp", "Globex", "Initech", "Umbra", "Soylent"];

const testimonial = {
  quote:
    "Crest Meet replaced three tools for our revenue team. The cross-meeting chat alone saves me an hour of scrolling through recordings every week.",
  author: "Priya N.",
  role: "Head of Revenue Operations",
};

export function SocialProof() {
  return (
    <Section id="customers">
      <Container>
        <p className="text-center text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Trusted by modern revenue, product, and research teams
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-10 gap-y-6 opacity-70">
          {logos.map((name) => (
            <span
              key={name}
              className="font-display text-xl font-bold text-ink-mute"
            >
              {name}
            </span>
          ))}
        </div>

        <div className="mx-auto mt-14 max-w-3xl">
          <figure className="card p-8 text-center">
            <blockquote className="text-lg font-medium leading-relaxed text-ink sm:text-xl">
              “{testimonial.quote}”
            </blockquote>
            <figcaption className="mt-6">
              <p className="font-semibold text-ink">{testimonial.author}</p>
              <p className="text-sm text-ink-mute">{testimonial.role}</p>
            </figcaption>
          </figure>
        </div>
      </Container>
    </Section>
  );
}
