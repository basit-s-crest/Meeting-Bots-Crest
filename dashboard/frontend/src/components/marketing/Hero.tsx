"use client";

import { ArrowRight, Mic, Play, Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/context/AuthContext";

const transcript = [
  {
    who: "Sarah · Product",
    text: "Let's lock the launch date for the new onboarding flow.",
    ai: false,
  },
  {
    who: "James · Eng",
    text: "I can have the API ready by next Tuesday if design signs off.",
    ai: false,
  },
  {
    who: "Crest Meet AI",
    text: "Action: Sarah to confirm launch date. James to deliver API by Tue.",
    ai: true,
  },
];

export function Hero() {
  const { user } = useAuth() || {};

  return (
    <div className="relative border-b border-border bg-surface">
      <div className="hero-gradient" aria-hidden />
      <Container className="relative pb-20 pt-16 sm:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
          {/* Left — typographic anchor (left-biased, breaks symmetry) */}
          <div className="max-w-xl">
            <div className="mb-6 flex" style={{ ["--i" as string]: 0 }}>
              <span className="hall-reveal">
                <Badge tone="brand">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse-slow" />
                  Now with cross-meeting AI chat
                </Badge>
              </span>
            </div>
            <h1
              className="hall-reveal font-display text-4xl font-extrabold tracking-tight text-ink sm:text-6xl"
              style={{ ["--i" as string]: 1 }}
            >
              Every meeting,{" "}
              <span className="text-brand-600">turned into knowledge</span>.
            </h1>
            <p
              className="hall-reveal mt-6 max-w-xl text-lg leading-relaxed text-ink-mute"
              style={{ ["--i" as string]: 2 }}
            >
              Crest Meet deploys AI bots to Google Meet, Zoom, and Teams. They
              join, transcribe in real time, summarize, and let you ask across
              every meeting at once.
            </p>
            <div
              className="hall-reveal mt-9 flex flex-col items-start gap-3 sm:flex-row"
              style={{ ["--i" as string]: 3 }}
            >
              <Button href={user ? "/projects" : "/login"} size="lg">
                {user ? "Open the app" : "Get started"}
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button href={user ? "/projects" : "/login"} variant="secondary" size="lg">
                <Play className="h-4 w-4" />
                Watch demo
              </Button>
            </div>
            <p
              className="hall-reveal mt-4 text-xs text-ink-faint"
              style={{ ["--i" as string]: 4 }}
            >
              No credit card required · Works with your existing calendar
            </p>
          </div>

          {/* Right — E1 Tier-A CSS-art live transcript panel (real content, hairline frame) */}
          <div
            className="hall-reveal"
            style={{ ["--i" as string]: 5 }}
          >
            <div className="card overflow-hidden shadow-pop">
              <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-3">
                <Mic className="h-3.5 w-3.5 text-brand-600" />
                <span className="text-xs font-medium text-ink-soft">
                  Live transcript · Q3 Planning Sync
                </span>
                <span className="ml-auto flex items-center gap-1.5 text-xs text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-slow" />
                  Recording
                </span>
              </div>
              <div className="divide-y divide-border">
                {transcript.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.ai
                        ? "bg-brand-50/60 p-4"
                        : "bg-surface p-4"
                    }
                  >
                    <div className="flex items-center gap-2">
                      <p
                        className={
                          line.ai
                            ? "text-xs font-semibold text-brand-700"
                            : "text-xs font-semibold text-ink-soft"
                        }
                      >
                        {line.who}
                      </p>
                      {line.ai && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                          <Check className="h-3 w-3" /> AI
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
                      {line.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Container>
    </div>
  );
}
