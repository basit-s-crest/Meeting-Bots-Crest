"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";

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

  return (
    <div className="flex min-h-screen flex-col justify-center py-12 sm:px-6 lg:px-8 bg-bg">
      <div className="sm:mx-auto sm:w-full sm:max-w-md flex flex-col items-center">
        <Logo />
        <h2 className="mt-6 text-center font-display text-3xl font-bold tracking-tight text-ink">
          Create your account
        </h2>
        <p className="mt-2 text-center text-sm text-ink-mute">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-semibold text-brand-600 hover:text-brand-500 transition-colors"
          >
            Log in here
          </Link>
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <Card className="p-8 bg-surface border border-border rounded-xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="rounded-lg bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400 font-semibold border border-red-500/20">
                {error}
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

            <Input
              id="password"
              type="password"
              label="Password (min 6 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              disabled={submitting}
            />

            <Button type="submit" className="w-full flex justify-center py-3" disabled={submitting}>
              {submitting ? "Creating account..." : "Sign up"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
