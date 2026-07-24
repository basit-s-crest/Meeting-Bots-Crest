"use client";

import Link from "next/link";
import { ArrowLeft, Mic, FileText, MessageSquare } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Logo } from "@/components/ui/Logo";

const features = [
  { icon: Mic, text: "Real-time transcription" },
  { icon: FileText, text: "AI-powered summaries" },
  { icon: MessageSquare, text: "Ask across all meetings" },
];

interface AuthShellProps {
  title: string;
  subtitle: React.ReactNode;
  children: React.ReactNode;
}

export function AuthShell({ title, subtitle, children }: AuthShellProps) {
  return (
    <div className="page-bg min-h-screen">
      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-12 lg:grid-cols-2 lg:gap-0">
        {/* Left — brand visual */}
        <div
          className="hall-reveal flex flex-col justify-center p-8 sm:p-12"
          style={{ ["--i" as string]: 0 }}
        >
          <Logo />
          <h1 className="mt-8 font-display text-4xl font-extrabold tracking-tight text-ink sm:text-5xl">
            Every meeting,{" "}
            <span className="text-brand-600">turned into knowledge</span>.
          </h1>
          <p className="mt-4 max-w-sm text-lg leading-relaxed text-ink-mute">
            Crest Meet deploys AI bots to Google Meet, Zoom, and Teams. They
            join, transcribe in real time, summarize, and let you ask across
            every meeting at once.
          </p>
          <ul className="mt-8 space-y-3">
            {features.map((f) => (
              <li
                key={f.text}
                className="flex items-center gap-3 text-sm text-ink-soft transition-colors hover:text-ink"
              >
                <f.icon className="h-5 w-5 text-brand-600" />
                {f.text}
              </li>
            ))}
          </ul>
        </div>

        {/* Right — form */}
        <div
          className="hall-reveal flex items-center justify-center p-8"
          style={{ ["--i" as string]: 1 }}
        >
          <Card className="w-full max-w-md p-8 shadow-pop">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-mute hover:text-ink transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to Home
            </Link>
            <h2 className="mt-4 font-display text-2xl font-bold tracking-tight text-ink">
              {title}
            </h2>
            <p className="mt-2 text-sm text-ink-mute">{subtitle}</p>
            {children}
          </Card>
        </div>
      </div>
    </div>
  );
}
