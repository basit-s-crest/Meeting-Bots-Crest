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

      {/* Final CTA */}
      <section className="bg-brand-600">
        <Container className="py-16 text-center">
          <h2 className="font-display text-3xl font-bold text-white sm:text-4xl">
            Start capturing every conversation
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-brand-100">
            Open the workspace, create a project, and launch your first meeting bot in under a
            minute.
          </p>
          <div className="mt-8 flex justify-center">
            <Button href="/projects" size="lg" variant="secondary">
              Open the app
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </Container>
      </section>
    </>
  );
}
