import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { Container } from "@/components/ui/Container";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col bg-bg">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur-md">
        <Container className="flex h-16 items-center justify-between">
          <Logo />
          <Link
            href="/"
            className="text-sm font-medium text-ink-soft transition-colors hover:text-ink"
          >
            Back to home
          </Link>
        </Container>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
