import { Hero } from "@/components/marketing/Hero";
import { Features } from "@/components/marketing/Features";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { SocialProof } from "@/components/marketing/SocialProof";
import { Container } from "@/components/ui/Container";
import { Button } from "@/components/ui/Button";
import { ArrowRight } from "lucide-react";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <Features />
      <HowItWorks />
      <SocialProof />

      {/* Final CTA — single verb, left-biased to cohere with the hero */}
      <section className="border-t border-border bg-surface">
        <Container className="py-20">
          <div className="flex flex-col items-start gap-6 md:flex-row md:items-end md:justify-between">
            <div className="max-w-xl">
              <h2 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                Start capturing every conversation.
              </h2>
              <p className="mt-4 text-lg text-ink-mute">
                Open the workspace, create a project, and launch your first meeting bot in under a
                minute.
              </p>
            </div>
            <Button href="/projects" size="lg">
              Open the app
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </Container>
      </section>
    </>
  );
}
