"use client";

import { useEffect, useState } from "react";
import { HardDrive, CheckCircle2, XCircle, RefreshCw, ExternalLink, X, ShieldCheck, FileCheck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

const BACKEND_URL = "http://localhost:3000";

interface DriveStatus {
  connected: boolean;
  configured: boolean;
}

interface GoogleDriveModalProps {
  open: boolean;
  onClose: () => void;
  onStatusChange?: (connected: boolean) => void;
}

export function GoogleDriveModal({ open, onClose, onStatusChange }: GoogleDriveModalProps) {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState("");

  async function checkStatus() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/google/status`, {
        credentials: "include"
      });
      if (!res.ok) throw new Error("Failed to load Google Drive status");
      const data: DriveStatus = await res.json();
      setStatus(data);
      if (onStatusChange) onStatusChange(data.connected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check Google Drive status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      checkStatus();
    }
  }, [open]);

  async function handleDisconnect() {
    if (!confirm("Are you sure you want to disconnect Google Drive? Syncing will pause.")) return;
    setDisconnecting(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/google/disconnect`, {
        method: "POST",
        credentials: "include"
      });
      if (!res.ok) throw new Error("Failed to disconnect Google Drive");
      const newStatus = { connected: false, configured: status?.configured ?? true };
      setStatus(newStatus);
      if (onStatusChange) onStatusChange(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error disconnecting Drive");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} className="max-w-lg p-0 overflow-hidden shadow-pop">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-surface-2/50">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 border border-blue-500/20">
            <HardDrive className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-ink">Google Drive Sync</h2>
            <p className="text-xs text-ink-mute">Cloud storage integration for meeting exports</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-ink-mute transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer"
          aria-label="Close modal"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Body */}
      <div className="p-6 space-y-6 bg-surface">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-ink-mute gap-2.5">
            <RefreshCw className="h-4 w-4 animate-spin text-brand-600" />
            <span>Checking Google Drive authorization…</span>
          </div>
        ) : error ? (
          <div className="rounded-xl border border-danger/30 bg-danger-soft/40 p-4 text-center">
            <p className="text-xs font-semibold text-danger">{error}</p>
            <Button size="sm" variant="ghost" onClick={checkStatus} className="mt-2 text-xs">
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : (
          <>
            {/* Status Banner */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between p-4 rounded-xl border border-border/80 bg-surface-2/30">
              <div className="flex items-center gap-3">
                {status?.connected ? (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                    <CheckCircle2 className="h-5 w-5" />
                  </div>
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/10 text-amber-600">
                    <XCircle className="h-5 w-5" />
                  </div>
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink">Connection Status</span>
                    {status?.connected ? (
                      <Badge tone="success" className="text-[11px] font-semibold px-2 py-0.5">Connected</Badge>
                    ) : (
                      <Badge tone="warning" className="text-[11px] font-semibold px-2 py-0.5">Not Connected</Badge>
                    )}
                  </div>
                  <p className="text-xs text-ink-mute mt-0.5">
                    {status?.connected
                      ? "Transcripts and AI reports auto-sync to your Google Drive."
                      : "Connect your account to backup project exports to Google Drive."}
                  </p>
                </div>
              </div>
            </div>

            {/* Feature Highlights */}
            <div className="space-y-2.5">
              <h3 className="text-xs font-semibold text-ink uppercase tracking-wider">Sync Specifications</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-ink-soft">
                <div className="flex items-center gap-2 p-2.5 rounded-lg border border-border/60 bg-surface">
                  <FileCheck className="h-4 w-4 text-brand-600 shrink-0" />
                  <span>Transcripts (.jsonl + .txt)</span>
                </div>
                <div className="flex items-center gap-2 p-2.5 rounded-lg border border-border/60 bg-surface">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0" />
                  <span>AI Reports (.md + .docx)</span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="pt-4 border-t border-border/60 flex items-center justify-between gap-3">
              {status?.connected ? (
                <>
                  <a
                    href="https://drive.google.com/drive/my-drive"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-xs font-semibold text-ink transition-colors hover:bg-surface-2"
                  >
                    <ExternalLink className="h-3.5 w-3.5 text-brand-600" />
                    <span>Open Drive</span>
                  </a>
                  <Button variant="danger" size="sm" onClick={handleDisconnect} disabled={disconnecting}>
                    <XCircle className="h-3.5 w-3.5" />
                    {disconnecting ? "Disconnecting…" : "Disconnect Drive"}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    Cancel
                  </Button>
                  <a
                    href={`${BACKEND_URL}/api/auth/google`}
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-brand-700"
                  >
                    <HardDrive className="h-4 w-4" />
                    <span>Connect Google Drive</span>
                  </a>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
