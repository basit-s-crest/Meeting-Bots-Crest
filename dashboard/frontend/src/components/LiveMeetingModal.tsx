"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Radio, Sparkles, X, Folder } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

const BACKEND_URL = "http://localhost:3000";

interface ProjectItem {
  id: string;
  name: string;
}

interface BotStartEventData {
  sessionId: string;
  botType: string;
  meetingUrl?: string;
  botName?: string;
  projectId?: string;
  title?: string;
}

export function LiveMeetingModal() {
  const router = useRouter();
  const [activeEventData, setActiveEventData] = useState<BotStartEventData | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [joining, setJoining] = useState(false);

  // Subscribe to real-time backend event stream
  useEffect(() => {
    const eventSource = new EventSource(`${BACKEND_URL}/api/events/subscribe`, {
      withCredentials: true
    });

    eventSource.addEventListener("bot_started", (e: MessageEvent) => {
      try {
        const data: BotStartEventData = JSON.parse(e.data);
        console.log("[LiveMeetingModal] bot_started event received:", data);
        setActiveEventData(data);
        if (data.projectId) {
          setSelectedProjectId(data.projectId);
        }
      } catch (err) {
        console.error("[LiveMeetingModal] Error parsing event data:", err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, []);

  // Fetch projects list when modal opens
  useEffect(() => {
    if (!activeEventData) return;

    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/projects`, { credentials: "include" });
        if (res.ok) {
          const list: ProjectItem[] = await res.json();
          setProjects(list);
          if (list.length > 0 && !selectedProjectId) {
            setSelectedProjectId(list[0].id);
          }
        }
      } catch (err) {
        console.error("[LiveMeetingModal] Error fetching projects list:", err);
      }
    })();
  }, [activeEventData, selectedProjectId]);

  if (!activeEventData) return null;

  async function handleJoinLiveSession() {
    if (!selectedProjectId) {
      alert("Please select a target project workspace.");
      return;
    }

    setJoining(true);

    try {
      // Update session's assigned project ID on backend & Supabase
      await fetch(`${BACKEND_URL}/api/sessions/update-project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          sessionId: activeEventData?.sessionId,
          projectId: selectedProjectId
        })
      });

      const targetId = selectedProjectId;
      setActiveEventData(null);
      setJoining(false);

      // Redirect to live transcript page for the chosen project
      router.push(`/projects/${targetId}/meeting`);
    } catch (err) {
      console.error("[LiveMeetingModal] Error linking session to project:", err);
      setJoining(false);
      router.push(`/projects/${selectedProjectId}/meeting`);
    }
  }

  return (
    <Modal
      open={!!activeEventData}
      onClose={() => setActiveEventData(null)}
      className="max-w-lg overflow-hidden border border-emerald-500/30 p-0 shadow-2xl"
    >
      {/* Header Banner */}
      <div className="flex items-center justify-between border-b border-border bg-gradient-to-r from-emerald-500/15 via-emerald-500/5 to-transparent p-5">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3.5 w-3.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-emerald-500" />
          </span>
          <div>
            <h3 className="font-display text-base font-bold text-ink flex items-center gap-2">
              Live Meeting Bot Auto-Joined
              <Badge tone="success">{activeEventData.botType || "google-meet"}</Badge>
            </h3>
            <p className="text-xs text-ink-mute">
              Bot is currently inside the meeting room capturing live transcript.
            </p>
          </div>
        </div>
        <button
          onClick={() => setActiveEventData(null)}
          className="rounded-lg p-1.5 text-ink-mute hover:bg-surface-2 hover:text-ink transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body Content */}
      <div className="space-y-4 p-6">
        <div className="rounded-xl border border-border bg-surface-2/50 p-3.5 space-y-1">
          <div className="text-xs text-ink-mute font-medium flex items-center gap-1.5">
            <Radio className="h-3.5 w-3.5 text-emerald-500" />
            <span>Active Bot Session:</span>
          </div>
          <p className="text-sm font-semibold text-ink truncate">
            {activeEventData.title || activeEventData.botName || "Calendar Meeting Session"}
          </p>
          {activeEventData.meetingUrl && (
            <p className="text-xs text-ink-soft truncate font-mono">
              {activeEventData.meetingUrl}
            </p>
          )}
        </div>

        {/* Project Selector Dropdown */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-ink flex items-center gap-1.5">
            <Folder className="h-4 w-4 text-brand-500" />
            <span>Select Target Project Workspace:</span>
          </label>
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm font-medium text-ink shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                📁 {p.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-ink-mute">
            Live audio, transcripts, and AI summaries will be stored in this project workspace.
          </p>
        </div>
      </div>

      {/* Action Footer */}
      <div className="flex items-center justify-end gap-3 border-t border-border bg-surface-2/40 p-4">
        <Button variant="ghost" size="sm" onClick={() => setActiveEventData(null)}>
          Dismiss
        </Button>
        <Button
          size="sm"
          onClick={handleJoinLiveSession}
          disabled={joining || !selectedProjectId}
          className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-sm"
        >
          <Eye className="h-4 w-4" />
          {joining ? "Linking Project…" : "Join Live Transcript & Q&A →"}
        </Button>
      </div>
    </Modal>
  );
}
