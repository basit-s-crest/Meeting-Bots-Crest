import { Radio, FileSearch, MessagesSquare } from "lucide-react";
import { Container } from "@/components/ui/Container";
import { Section, SectionHeading } from "@/components/ui/Section";

const steps = [
  {
    icon: Radio,
    step: "01",
    title: "Connect a bot",
    desc: "Pick your platform, paste the meeting link, and launch. Crest Meet joins invisibly and starts listening.",
  },
  {
    icon: FileSearch,
    step: "02",
    title: "Capture & summarize",
    desc: "Transcripts stream live, then an AI report distills decisions, action items, and who said what.",
  },
  {
    icon: MessagesSquare,
    step: "03",
    title: "Ask across meetings",
    desc: "Chat with your project's entire history — “What did we decide about pricing?” gets a cited answer instantly.",
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works" className="border-y border-border bg-surface-2">
      <Container>
        <SectionHeading
          align="left"
          eyebrow="How it works"
          title="From calendar invite to actionable insight"
          subtitle="Three steps. No manual note-taking, no digging through recordings."
        />
        <ol className="mt-12 grid gap-8 md:grid-cols-3 md:gap-0">
          {steps.map((s, i) => (
            <li key={s.step} className="relative md:px-8 md:first:pl-0 md:last:pr-0">
              {/* hairline connector between steps (desktop) */}
              {i < steps.length - 1 && (
                <span
                  aria-hidden
                  className="absolute right-0 top-6 hidden h-px w-16 bg-border-strong md:block"
                />
              )}
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-sm">
                  <s.icon className="h-5 w-5" />
                </span>
                <span className="font-display text-2xl font-bold text-brand-600 tabular-nums">
                  {s.step}
                </span>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-mute">{s.desc}</p>
            </li>
          ))}
        </ol>
      </Container>
    </Section>
  );
}
