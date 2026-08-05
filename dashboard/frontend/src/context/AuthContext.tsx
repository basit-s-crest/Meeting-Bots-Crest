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

const BACKEND_URL = "http://localhost:3000";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const checkAuth = async () => {
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${BACKEND_URL}/api/auth/me`, {
        method: "GET",
        headers,
        credentials: "include",
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
      localStorage.setItem("token", data.token);
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
      localStorage.setItem("token", data.token);
    }
    setUser(data.user);
    router.push("/projects");
  };

  const logout = async () => {
    try {
      localStorage.removeItem("token");
      await fetch(`${BACKEND_URL}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch (e) {
      console.error("[Auth] Logout request failed:", e);
    } finally {
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
