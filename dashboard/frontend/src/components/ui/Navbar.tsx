"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";
import { Container } from "@/components/ui/Container";
import { useAuth } from "@/context/AuthContext";

const navLinks = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#customers", label: "Customers" },
];

export function Navbar() {
  const { user } = useAuth() || {};

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur-md">
      <Container className="flex h-16 items-center justify-between">
        <Logo />
        <nav className="hidden md:flex items-center gap-8">
          {navLinks.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-ink-soft transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <Link
            href={user ? "/projects" : "/login"}
            className="hidden sm:inline-flex text-sm font-semibold text-ink-soft transition-colors hover:text-ink"
          >
            {user ? "Dashboard" : "Sign in"}
          </Link>
          <Button href={user ? "/projects" : "/login"} size="sm">
            Open App
          </Button>
        </div>
      </Container>
    </header>
  );
}
