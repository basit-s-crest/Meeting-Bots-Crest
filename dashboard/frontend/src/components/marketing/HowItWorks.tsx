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
    desc: "Chat with your project's entire history — 'What did we decide about pricing?' gets a cited answer instantly.",
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works" className="bg-surface border-y border-border">
      <Container>
        <SectionHeading
          eyebrow="How it works"
          title="From calendar invite to actionable insight"
          subtitle="Three steps. No manual note-taking, no digging through recordings."
        />
        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.step} className="relative">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-sm">
                  <s.icon className="h-5 w-5" />
                </span>
                <span className="font-display text-2xl font-bold text-brand-200">{s.step}</span>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 text-sm text-ink-mute leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </Container>
    </Section>
  );
}
