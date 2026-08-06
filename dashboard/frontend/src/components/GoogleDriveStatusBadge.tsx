"use client";

import { useEffect, useState } from "react";
import { HardDrive, CheckCircle2 } from "lucide-react";
import { GoogleDriveModal } from "@/components/GoogleDriveModal";

import { BACKEND_URL, apiFetch } from "@/context/AuthContext";

interface GoogleDriveStatusBadgeProps {
  className?: string;
  variant?: "badge" | "button";
}

export function GoogleDriveStatusBadge({ className = "", variant = "badge" }: GoogleDriveStatusBadgeProps) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let isMounted = true;
    async function checkStatus() {
      try {
        const res = await apiFetch(`${BACKEND_URL}/api/auth/google/status`);
        if (res.ok && isMounted) {
          const data = await res.json();
          setConnected(data.connected);
        }
      } catch (err) {
        if (isMounted) setConnected(false);
      }
    }
    checkStatus();
    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <>
      {variant === "button" ? (
        <button
          onClick={() => setModalOpen(true)}
          className={`inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-soft transition-all hover:bg-surface-2 hover:text-ink cursor-pointer ${className}`}
        >
          <HardDrive className={`h-4 w-4 ${connected ? "text-emerald-500" : "text-ink-faint"}`} />
          <span>{connected ? "Drive Synced" : "Connect Drive"}</span>
          {connected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
        </button>
      ) : (
        <button
          onClick={() => setModalOpen(true)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-all cursor-pointer ${
            connected
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20"
              : "border-border bg-surface-2/60 text-ink-soft hover:bg-surface-2 hover:text-ink"
          } ${className}`}
          title="Google Drive Sync Status"
        >
          <HardDrive className="h-3.5 w-3.5" />
          <span>{connected ? "Drive Connected" : "Drive"}</span>
        </button>
      )}

      <GoogleDriveModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onStatusChange={(isConn) => setConnected(isConn)}
      />
    </>
  );
}
