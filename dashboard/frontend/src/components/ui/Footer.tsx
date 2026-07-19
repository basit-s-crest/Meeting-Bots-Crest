import { Logo } from "@/components/ui/Logo";
import { Container } from "@/components/ui/Container";

const columns = [
  {
    title: "Product",
    links: ["Features", "How it works", "Integrations", "Pricing"],
  },
  {
    title: "Platforms",
    links: ["Google Meet", "Zoom", "Microsoft Teams", "Webex"],
  },
  {
    title: "Company",
    links: ["About", "Blog", "Careers", "Contact"],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-surface">
      <Container className="py-12">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <Logo />
            <p className="mt-4 max-w-xs text-sm text-ink-mute leading-relaxed">
              Turn every meeting into searchable, actionable knowledge with AI bots that
              join, transcribe, and summarize.
            </p>
          </div>
          {columns.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold text-ink">{col.title}</h4>
              <ul className="mt-3 space-y-2">
                {col.links.map((link) => (
                  <li key={link}>
                    <a
                      href="#"
                      className="text-sm text-ink-mute transition-colors hover:text-ink"
                    >
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-col items-center justify-between gap-4 border-t border-border pt-6 sm:flex-row">
          <p className="text-sm text-ink-faint">
            © {new Date().getFullYear()} Crest Meet. All rights reserved.
          </p>
          <div className="flex items-center gap-6 text-sm text-ink-mute">
            <a href="#" className="hover:text-ink transition-colors">Privacy</a>
            <a href="#" className="hover:text-ink transition-colors">Terms</a>
            <a href="#" className="hover:text-ink transition-colors">Security</a>
          </div>
        </div>
      </Container>
    </footer>
  );
}
