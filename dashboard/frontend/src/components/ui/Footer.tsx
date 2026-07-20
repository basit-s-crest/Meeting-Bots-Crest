import { Logo } from "@/components/ui/Logo";
import { Container } from "@/components/ui/Container";

const links = ["Features", "How it works", "Customers", "Privacy", "Terms", "Security"];

export function Footer() {
  return (
    <footer className="border-t border-border bg-surface">
      <Container className="py-8">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-4">
            <Logo />
            <span className="hidden text-sm text-ink-faint sm:inline">
              © {new Date().getFullYear()} Crest Meet
            </span>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {links.map((link) => (
              <a
                key={link}
                href="#"
                className="whitespace-nowrap text-sm text-ink-mute transition-colors hover:text-ink"
              >
                {link}
              </a>
            ))}
          </nav>
        </div>
      </Container>
    </footer>
  );
}
