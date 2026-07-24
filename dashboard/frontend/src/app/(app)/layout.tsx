"use client";

import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { Container } from "@/components/ui/Container";
import { useAuth } from "@/context/AuthContext";
import { LogOut, User } from "lucide-react";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent"></div>
          <p className="text-sm text-ink-mute font-medium">Verifying session...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="flex min-h-full flex-col bg-bg">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur-md">
        <Container className="flex h-16 items-center justify-between max-w-none px-4 sm:px-6 lg:px-8">
          <Logo />
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-ink-soft font-semibold">
              <User className="h-3.5 w-3.5 text-ink-faint" />
              <span>{user.name}</span>
            </div>
            <button
              onClick={logout}
              className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft hover:text-red-500 transition-colors cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
              <span>Logout</span>
            </button>
          </div>
        </Container>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
