"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { signup } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !password.trim()) return;

    setError("");
    setSubmitting(true);

    try {
      await signup(name, email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign up");
    } finally {
      setSubmitting(false);
    }
  };

  const strength =
    password.length < 6 ? "Weak" : password.length < 10 ? "Medium" : "Strong";
  const strengthColor =
    password.length < 6
      ? "bg-warning"
      : password.length < 10
      ? "bg-brand-500"
      : "bg-success";
  const strengthWidth =
    password.length < 6 ? "w-1/3" : password.length < 10 ? "w-2/3" : "w-full";

  return (
    <AuthShell
      title="Create your account"
      subtitle={
        <>
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-semibold text-brand-600 hover:text-brand-500 transition-colors"
          >
            Log in here
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="mt-6 space-y-6">
        {error && (
          <div className="flex items-start gap-2.5 rounded-lg bg-danger-soft p-3.5 text-sm text-danger border border-danger/20">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Input
          id="name"
          type="text"
          label="Full Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="John Doe"
          required
          disabled={submitting}
        />

        <Input
          id="email"
          type="email"
          label="Email Address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          disabled={submitting}
        />

        <div className="space-y-1.5">
          <PasswordInput
            id="password"
            label="Password (min 6 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            disabled={submitting}
          />
          {password && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-ink-mute">
                <span>Password strength</span>
                <span>{strength}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    strengthColor,
                    strengthWidth,
                  )}
                />
              </div>
            </div>
          )}
        </div>

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? "Creating account..." : "Sign up"}
        </Button>
      </form>
    </AuthShell>
  );
}
