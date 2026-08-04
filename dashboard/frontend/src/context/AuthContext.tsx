"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";

interface User {
  id: string;
  name: string;
  email: string;
  created_at?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const BACKEND_URL = "http://localhost:3000";

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") return new Response();

  const token = localStorage.getItem("auth_token");
  const headers = new Headers(init?.headers || {});

  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await window.fetch(input, {
    ...init,
    headers,
    credentials: "include",
  });

  if (res.status === 401) {
    localStorage.removeItem("auth_token");
    if (typeof window !== "undefined" && window.location.pathname !== "/login" && window.location.pathname !== "/signup") {
      window.location.href = "/login";
    }
  }

  return res;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const checkAuth = async () => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/auth/me`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      } else {
        setUser(null);
      }
    } catch (err) {
      console.error("[Auth] Session check failed:", err);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  // Handle route protection client-side
  useEffect(() => {
    if (loading) return;

    const isAuthRoute = pathname === "/login" || pathname === "/signup";
    const isAppRoute = pathname.startsWith("/projects") || pathname.startsWith("/dashboard");

    if (!user && isAppRoute) {
      router.replace("/login");
    } else if (user && isAuthRoute) {
      router.replace("/projects");
    }
  }, [user, loading, pathname, router]);

  const login = async (email: string, password: string) => {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      credentials: "include",
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Login failed");
    }

    if (data.token) {
      localStorage.setItem("auth_token", data.token);
    }

    setUser(data.user);
    router.push("/projects");
  };

  const signup = async (name: string, email: string, password: string) => {
    const res = await fetch(`${BACKEND_URL}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
      credentials: "include",
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Sign up failed");
    }

    if (data.token) {
      localStorage.setItem("auth_token", data.token);
    }

    setUser(data.user);
    router.push("/projects");
  };

  const logout = async () => {
    try {
      await apiFetch(`${BACKEND_URL}/api/auth/logout`, {
        method: "POST",
      });
    } catch (e) {
      console.error("[Auth] Logout request failed:", e);
    } finally {
      localStorage.removeItem("auth_token");
      setUser(null);
      router.replace("/");
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
