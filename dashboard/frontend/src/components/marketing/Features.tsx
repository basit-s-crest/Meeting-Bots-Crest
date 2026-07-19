import { Mic, Sparkles, MessagesSquare, CalendarClock, ShieldCheck, Globe } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Container } from "@/components/ui/Container";
import { Section, SectionHeading } from "@/components/ui/Section";

const features = [
  {
    icon: Mic,
    title: "Live transcription",
    desc: "AI bots join Google Meet, Zoom, and Teams to capture word-for-word transcripts in real time.",
  },
  {
    icon: Sparkles,
    title: "AI summaries",
    desc: "Every session gets an executive summary, key highlights, and a speaker talk-time breakdown.",
  },
  {
    icon: MessagesSquare,
    title: "Cross-meeting chat",
    desc: "Ask one question and get answers pulled from every meeting in a project, with cited sources.",
  },
  {
    icon: CalendarClock,
    title: "Smart scheduling",
    desc: "Detected follow-ups are turned into calendar events with a single click — Zoom links included.",
  },
  {
    icon: Globe,
    title: "Cloud sync",
    desc: "Auto-sync recordings and documents to Google Drive so nothing lives only on your machine.",
  },
  {
    icon: ShieldCheck,
    title: "Private by default",
    desc: "Projects are scoped workspaces. Your transcripts and summaries stay organized and isolated.",
  },
];

export function Features() {
  return (
    <Section id="features">
      <Container>
        <SectionHeading
          eyebrow="Why Crest Meet"
          title="Everything your meetings produce, in one place"
          subtitle="From the moment a bot joins to the action items it surfaces — Crest Meet handles the busywork of capturing and organizing conversations."
        />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <Card key={f.title} hover className="p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-ink">{f.title}</h3>
              <p className="mt-2 text-sm text-ink-mute leading-relaxed">{f.desc}</p>
            </Card>
          ))}
        </div>
      </Container>
    </Section>
  );
}
