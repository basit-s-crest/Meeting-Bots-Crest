import { ArrowRight, Mic, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { Badge } from "@/components/ui/Badge";

export function Hero() {
  return (
    <div className="hero-gradient border-b border-border">
      <Container className="relative pb-20 pt-16 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-6 flex justify-center">
            <Badge tone="brand" className="animate-fade-in-up">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse-slow" />
              Now with cross-meeting AI chat
            </Badge>
          </div>
          <h1 className="animate-fade-in-up font-display text-4xl font-extrabold tracking-tight text-ink sm:text-6xl [animation-delay:60ms]">
            Turn every meeting into{" "}
            <span className="bg-gradient-to-r from-brand-600 to-brand-400 bg-clip-text text-transparent">
              searchable knowledge
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-ink-mute leading-relaxed [animation-delay:120ms] animate-fade-in-up">
            Crest Meet deploys AI bots to Google Meet, Zoom, and Teams. They join, transcribe
            in real time, generate smart summaries, and let you ask questions across all your
            meetings at once.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row [animation-delay:180ms] animate-fade-in-up">
            <Button href="/projects" size="lg">
              Open the app
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button href="/projects" variant="secondary" size="lg">
              <Play className="h-4 w-4" />
              Watch demo
            </Button>
          </div>
          <p className="mt-4 text-xs text-ink-faint">
            No credit card required · Works with your existing calendar
          </p>
        </div>

        {/* Product preview mock */}
        <div className="mx-auto mt-16 max-w-4xl [animation-delay:240ms] animate-fade-in-up">
          <div className="card overflow-hidden shadow-pop">
            <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-3">
              <span className="h-3 w-3 rounded-full bg-danger-soft" />
              <span className="h-3 w-3 rounded-full bg-warning-soft" />
              <span className="h-3 w-3 rounded-full bg-success-soft" />
              <div className="ml-3 flex items-center gap-2 text-xs text-ink-mute">
                <Mic className="h-3.5 w-3.5 text-brand-600" />
                Live transcript · Q3 Planning Sync
              </div>
            </div>
            <div className="grid gap-px bg-border sm:grid-cols-3">
              {[
                { who: "Sarah (Product)", text: "Let's lock the launch date for the new onboarding flow." },
                { who: "James (Eng)", text: "I can have the API ready by next Tuesday if design signs off." },
                { who: "Crest Meet AI", text: "Action: Sarah to confirm launch date. James to deliver API by Tue." },
              ].map((line, i) => (
                <div key={i} className="bg-surface p-4">
                  <p className="text-xs font-semibold text-brand-600">{line.who}</p>
                  <p className="mt-1.5 text-sm text-ink-soft leading-relaxed">{line.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Container>
    </div>
  );
}
