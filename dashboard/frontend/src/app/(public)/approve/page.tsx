"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  CalendarDays,
  Clock,
  CheckCircle2,
  Check,
  Loader2,
  AlertCircle,
  User,
  Mail
} from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

const BACKEND_URL = "http://localhost:3000";

interface Proposal {
  id: string;
  token: string;
  title: string;
  date?: string;
  time?: string;
  timezone?: string;
  raw_mention?: string;
  status: string;
  roster?: string[];
}

interface ApprovalEntry {
  name: string;
  email: string;
  approved_at: string;
}

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "not_open"; message: string }
  | { kind: "scheduled"; message: string }
  | { kind: "ready"; proposal: Proposal; approvals: ApprovalEntry[]; alreadyVoted: boolean };

export default function PublicApprovalPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ApprovalPageContent />
    </Suspense>
  );
}

function ApprovalPageContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";

  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [voteError, setVoteError] = useState("");

  useEffect(() => {
    if (!token) {
      setState({ kind: "error", message: "Missing approval link. Please open the link from the meeting chat." });
      return;
    }

    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/approvals/public/${encodeURIComponent(token)}`, {
          credentials: "include"
        });

        if (res.status === 425) {
          setState({ kind: "not_open", message: "This meeting proposal has not been approved by the organizer yet. Please check back shortly." });
          return;
        }
        if (res.status === 409) {
          setState({ kind: "error", message: "This meeting proposal was rejected by the organizer." });
          return;
        }
        if (res.status === 410) {
          setState({ kind: "scheduled", message: "This meeting has already been scheduled." });
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setState({ kind: "error", message: data.error || "Failed to load the approval request." });
          return;
        }

        const data = await res.json();
        const approvals: ApprovalEntry[] = Array.isArray(data.proposal?.approvals)
          ? data.proposal.approvals
          : [];

        setState({
          kind: "ready",
          proposal: data.proposal,
          approvals,
          alreadyVoted: false
        });
      } catch {
        setState({ kind: "error", message: "Could not reach the server. Please try again." });
      }
    })();
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !name.trim() || !email.trim() || submitting) return;

    setSubmitting(true);
    setVoteError("");

    try {
      const res = await fetch(`${BACKEND_URL}/api/approvals/public/${encodeURIComponent(token)}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim(), email: email.trim() })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to record your approval");
      }

      const data = await res.json();
      setState((prev) =>
        prev.kind === "ready"
          ? {
              ...prev,
              approvals: Array.isArray(data.proposal?.approvals) ? data.proposal.approvals : prev.approvals,
              alreadyVoted: true
            }
          : prev
      );
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : "Failed to record your approval");
    } finally {
      setSubmitting(false);
    }
  };

  // ----------------------------------------------------------------------
  // Loading
  // ----------------------------------------------------------------------
  if (state.kind === "loading") {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 py-16 text-ink-mute">
          <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
          <p className="text-sm font-medium">Loading approval request...</p>
        </div>
      </Shell>
    );
  }

  // ----------------------------------------------------------------------
  // Error / not-open / scheduled
  // ----------------------------------------------------------------------
  if (state.kind === "error" || state.kind === "not_open" || state.kind === "scheduled") {
    const isScheduled = state.kind === "scheduled";
    const isNotOpen = state.kind === "not_open";
    return (
      <Shell>
        <Card className="w-full max-w-md p-8 text-center">
          <div
            className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl ${
              isScheduled ? "bg-success-soft text-success" : "bg-warning-soft text-warning"
            }`}
          >
            {isScheduled ? <CheckCircle2 className="h-7 w-7" /> : <AlertCircle className="h-7 w-7" />}
          </div>
          <h2 className="font-display text-xl font-bold text-ink">
            {isScheduled ? "Meeting Scheduled" : isNotOpen ? "Not Open for Approval Yet" : "Approval Unavailable"}
          </h2>
          <p className="mt-2 text-sm text-ink-soft">{state.message}</p>
        </Card>
      </Shell>
    );
  }

  // ----------------------------------------------------------------------
  // Ready — pick your name + email and approve
  // ----------------------------------------------------------------------
  const { proposal, approvals, alreadyVoted } = state;
  const whenText = [proposal.date, proposal.time].filter(Boolean).join(" at ");
  const tzText = proposal.timezone ? ` (${proposal.timezone})` : "";

  return (
    <Shell>
      <Card className="w-full max-w-lg p-8">
        <Badge tone="brand" className="mb-4">
          Scheduling approval
        </Badge>
        <h2 className="font-display text-2xl font-bold tracking-tight text-ink">{proposal.title || "Meeting"}</h2>

        {proposal.raw_mention && (
          <p className="mt-3 rounded border-l-4 border-brand-500 bg-surface-2/60 p-3 text-sm italic text-ink-soft">
            &ldquo;{proposal.raw_mention}&rdquo;
          </p>
        )}

        <div className="mt-5 space-y-2 text-sm text-ink-soft">
          {whenText && (
            <p className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-brand-600" />
              <span className="font-semibold text-ink">{whenText}</span>
              {tzText && <span className="text-ink-mute">{tzText}</span>}
            </p>
          )}
          {!whenText && (
            <p className="flex items-center gap-2 text-ink-mute">
              <Clock className="h-4 w-4" /> Date &amp; time to be decided
            </p>
          )}
        </div>

        <div className="mt-6 border-t border-border pt-5">
          <h3 className="mb-1 text-sm font-bold text-ink">Who are you?</h3>
          <p className="mb-4 text-xs text-ink-mute">
            Pick your name from the list below, then add your email so we can confirm your approval and notify you.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-ink-soft uppercase tracking-wider">
                Your name
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                <select
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full rounded-lg border border-border-strong bg-surface pl-9 pr-4 py-2.5 text-sm text-ink placeholder:text-ink-faint transition-colors focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                >
                  <option value="">Select your name...</option>
                  {(proposal.roster && proposal.roster.length > 0
                    ? proposal.roster
                    : SUGGESTED_NAMES
                  ).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <Input
              id="approval-email"
              type="email"
              label="Your email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="pl-9"
            />

            {voteError && (
              <div className="flex items-start gap-2.5 rounded-lg bg-danger-soft p-3.5 text-sm text-danger border border-danger/20">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{voteError}</span>
              </div>
            )}

            <Button type="submit" size="lg" className="w-full" disabled={submitting || !name.trim() || !email.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Recording…
                </>
              ) : alreadyVoted ? (
                <>
                  <Check className="h-4 w-4" /> You have approved
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" /> Approve this meeting
                </>
              )}
            </Button>
          </form>
        </div>

        {/* Approval tally */}
        {approvals.length > 0 && (
          <div className="mt-6 border-t border-border pt-4">
            <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-mute">
              {approvals.length} approval{approvals.length === 1 ? "" : "s"}
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {approvals.map((a) => (
                <span
                  key={a.email}
                  className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-xs font-semibold text-success"
                >
                  <Check className="h-3 w-3" />
                  {a.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>
    </Shell>
  );
}

// Fallback name list if the live Meet roster isn't available (e.g. the bot
// already left). In normal operation the dropdown uses the real roster names.
const SUGGESTED_NAMES = [
  "Alice Johnson",
  "Bob Smith",
  "Carol White",
  "David Brown",
  "Eve Davis",
  "Frank Miller"
];

function LoadingFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent"></div>
        <p className="text-sm font-medium text-ink-mute">Loading approval request...</p>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex h-16 items-center justify-between border-b border-border bg-surface/80 px-6 backdrop-blur-md">
        <Logo />
        <Link
          href="/login"
          className="text-xs font-semibold text-ink-soft transition-colors hover:text-brand-600"
        >
          Organizer? Sign in
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        {children}
      </main>
    </div>
  );
}
