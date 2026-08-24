"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "@/components/ui/Logo";
import { useAuth } from "@/context/AuthContext";
import {
  LogOut,
  User,
  FolderKanban,
  CheckSquare,
  HardDrive,
  CalendarDays,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  Mic
} from "lucide-react";
import { LiveMeetingModal } from "@/components/LiveMeetingModal";
import { cn } from "@/lib/cn";

const NAV_ITEMS = [
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/tasks", label: "My Tasks", icon: CheckSquare },
  { href: "/voice-profile", label: "Voice Profile", icon: Mic },
  { href: "/calendar", label: "Calendar", icon: CalendarDays }
];

// Persist the desktop collapse state across navigations.
const COLLAPSE_KEY = "crest-sidebar-collapsed";

function isActivePath(pathname: string, href: string) {
  return href === "/projects"
    ? pathname === "/projects" || pathname.startsWith("/projects/")
    : pathname.startsWith(href);
}

function NavList({
  collapsed,
  pathname,
  onNavigate
}: {
  collapsed: boolean;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      <nav
        className={cn("flex flex-col gap-1 p-3", collapsed && "items-center")}
        aria-label="Main"
      >
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActivePath(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-10 items-center rounded-lg text-sm font-semibold transition-colors",
                collapsed ? "w-10 justify-center" : "gap-2.5 px-3",
                active
                  ? "bg-brand-50 text-brand-700"
                  : "text-ink-soft hover:bg-surface-2 hover:text-ink"
              )}
              title={collapsed ? label : undefined}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {!collapsed && <span className="truncate">{label}</span>}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(COLLAPSE_KEY);
    if (saved === "1") setCollapsed(true);
  }, []);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent"></div>
          <p className="text-sm font-medium text-ink-mute">Verifying session...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      {/* Top header — logo left, user + logout right */}
      <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur-md">
        <div className="flex h-16 items-center justify-between pl-3 pr-4 sm:pl-3 sm:pr-6 lg:pl-3 lg:pr-8">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMobileOpen(true)}
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink md:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <Logo />
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-soft">
              <User className="h-3.5 w-3.5 text-ink-faint" />
              <span>{user.name}</span>
            </div>
            <button
              onClick={logout}
              className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-ink-soft transition-colors hover:text-red-500"
            >
              <LogOut className="h-4 w-4" />
              <span>Logout</span>
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 items-start">
        {/* Desktop sidebar — pinned, full height below header */}
        <aside
          className={cn(
            "sticky top-16 z-30 hidden h-[calc(100dvh-4rem)] shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 md:flex",
            collapsed ? "w-16" : "w-56"
          )}
        >
          {/* Nav */}
          <div className="flex-1 overflow-y-auto">
            <NavList collapsed={collapsed} pathname={pathname} />
          </div>

          {/* Footer — collapse toggle only */}
          <div
            className={cn(
              "shrink-0 border-t border-border p-3",
              collapsed && "flex flex-col items-center"
            )}
          >
            <button
              onClick={toggleCollapsed}
              className={cn(
                "flex h-10 w-full cursor-pointer items-center rounded-lg text-sm font-semibold text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink",
                collapsed ? "w-10 justify-center" : "gap-2.5 px-3"
              )}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? (
                <PanelLeftOpen className="h-5 w-5 shrink-0" />
              ) : (
                <PanelLeftClose className="h-5 w-5 shrink-0" />
              )}
              {!collapsed && <span>Collapse</span>}
            </button>
          </div>
        </aside>

        {/* Mobile drawer — slide-in from left with overlay */}
        <div
          className={cn(
            "fixed inset-0 z-50 transition-opacity duration-200 md:hidden",
            mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
          )}
          aria-hidden={!mobileOpen}
        >
          <div
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside
            className={cn(
              "absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r border-border bg-surface shadow-pop transition-transform duration-200",
              mobileOpen ? "translate-x-0" : "-translate-x-full"
            )}
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
              <Logo />
              <button
                onClick={() => setMobileOpen(false)}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavList collapsed={false} pathname={pathname} onNavigate={() => setMobileOpen(false)} />
            </div>
          </aside>
        </div>

        {/* Content — flexes with the sidebar width; the page scrolls here naturally */}
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <LiveMeetingModal />
    </div>
  );
}
