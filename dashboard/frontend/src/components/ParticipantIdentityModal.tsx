"use client";

import { useState } from "react";
import { UserCheck, Sparkles, AlertCircle, CheckCircle2, Loader2, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { apiFetch, BACKEND_URL } from "@/context/AuthContext";

interface ParticipantIdentityModalProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  speakerNames: string[];
  onConfirmed?: (selectedName: string) => void;
}

export function ParticipantIdentityModal({
  open,
  onClose,
  sessionId,
  speakerNames,
  onConfirmed
}: ParticipantIdentityModalProps) {
  const [selectedName, setSelectedName] = useState<string>("");
  const [customName, setCustomName] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Filter out duplicate or empty speaker names
  const cleanSpeakers = Array.from(new Set(speakerNames.filter(s => s && s.trim().length > 0)));

  const handleConfirm = async () => {
    const finalName = selectedName === "__custom__" ? customName.trim() : selectedName.trim();
    if (!finalName) {
      setError("Please select or enter your name.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch(`${BACKEND_URL}/api/fingerprints/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: finalName,
          sessionId: sessionId
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to confirm identity.");
      }

      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        if (onConfirmed) onConfirmed(finalName);
        onClose();
      }, 1200);
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} className="max-w-lg p-6 bg-surface border border-border shadow-2xl rounded-2xl">
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-500">
            <UserCheck className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-ink">Which participant were you?</h3>
            <p className="text-xs text-ink-mute">Help us link your voice & tasks across meetings</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg text-ink-mute hover:text-ink hover:bg-surface-2 transition"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="space-y-4 py-2">
        <p className="text-sm text-ink-mute leading-relaxed">
          Select your display name from this meeting transcript. We’ll automatically identify you in future calls and route your assigned action items directly to your dashboard.
        </p>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/10 border border-danger/20 text-danger text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 border border-success/20 text-success text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>Identity confirmed! We saved your profile signature.</span>
          </div>
        )}

        <div className="space-y-2 mt-2">
          <label className="text-xs font-semibold text-ink uppercase tracking-wider">
            Detected Meeting Participants
          </label>
          <div className="grid gap-2 max-h-48 overflow-y-auto pr-1">
            {cleanSpeakers.length > 0 ? (
              cleanSpeakers.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setSelectedName(name)}
                  className={`flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                    selectedName === name
                      ? "border-brand-500 bg-brand-500/5 ring-2 ring-brand-500/20 font-medium text-ink"
                      : "border-border hover:border-border-strong bg-surface hover:bg-surface-2 text-ink"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <div className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                      selectedName === name ? "border-brand-500 bg-brand-500" : "border-ink-mute"
                    }`}>
                      {selectedName === name && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>
                    <span className="text-sm">{name}</span>
                  </div>
                  <Badge tone={selectedName === name ? "brand" : "neutral"} className="text-[11px]">
                    {selectedName === name ? "Selected" : "Participant"}
                  </Badge>
                </button>
              ))
            ) : (
              <p className="text-xs text-ink-mute italic p-2">No transcript participants detected yet.</p>
            )}

            {/* Custom Name Entry option */}
            <button
              type="button"
              onClick={() => setSelectedName("__custom__")}
              className={`flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                selectedName === "__custom__"
                  ? "border-brand-500 bg-brand-500/5 ring-2 ring-brand-500/20 font-medium text-ink"
                  : "border-border hover:border-border-strong bg-surface hover:bg-surface-2 text-ink"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <div className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                  selectedName === "__custom__" ? "border-brand-500 bg-brand-500" : "border-ink-mute"
                }`}>
                  {selectedName === "__custom__" && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>
                <span className="text-sm text-ink-mute">Other / Type my display name manually</span>
              </div>
            </button>
          </div>

          {selectedName === "__custom__" && (
            <div className="mt-3">
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Basit Sachinwala"
                className="w-full px-3.5 py-2.5 rounded-xl border border-border bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
                autoFocus
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Skip for now
        </Button>
        <Button
          variant="primary"
          onClick={handleConfirm}
          disabled={submitting || (!selectedName || (selectedName === "__custom__" && !customName.trim()))}
          className="gap-2"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              Confirm & Save Profile
            </>
          )}
        </Button>
      </div>
    </Modal>
  );
}
