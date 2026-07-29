"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Radio, X, Folder, ChevronRight } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

const BACKEND_URL = "http://localhost:3000";

interface ProjectItem {
  id: string;
  name: string;
}

interface BotSessionData {
  sessionId: string;
  botType: string;
  meetingUrl?: string;
  botName?: string;
  projectId?: string;
  title?: string;
  status?: string;
}

export function LiveMeetingModal() {
  const router = useRouter();
  const [activeSessionData, setActiveSessionData] = useState<BotSessionData | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [joining, setJoining] = useState(false);

  // Helper to check active sessions on backend
  const checkActiveSessions = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/sessions`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const sessions: BotSessionData[] = data.sessions || [];
        if (sessions.length > 0) {
          const current = sessions[sessions.length - 1]; // take newest session
          setActiveSessionData(current);
          if (current.projectId) {
            setSelectedProjectId(current.projectId);
          }
        } else {
          setActiveSessionData(null);
          setIsModalOpen(false);
        }
      }
    } catch (err) {
      console.error("[LiveMeetingModal] Error fetching active sessions:", err);
    }
  };

  // Check active sessions on mount (e.g. late login / page refresh)
  useEffect(() => {
    checkActiveSessions();
  }, []);

  // Subscribe to real-time backend event stream (bot_started & bot_stopped)
  useEffect(() => {
    const eventSource = new EventSource(`${BACKEND_URL}/api/events/subscribe`, {
      withCredentials: true
    });

    eventSource.addEventListener("bot_started", (e: MessageEvent) => {
      try {
        const data: BotSessionData = JSON.parse(e.data);
        console.log("[LiveMeetingModal] bot_started event received:", data);
        setActiveSessionData(data);
        setIsModalOpen(true); // Automatically present project selection modal on new bot launch
        if (data.projectId) {
          setSelectedProjectId(data.projectId);
        }
      } catch (err) {
        console.error("[LiveMeetingModal] Error parsing bot_started event:", err);
      }
    });

    eventSource.addEventListener("bot_stopped", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        console.log("[LiveMeetingModal] bot_stopped event received:", data);
        // Refresh active sessions to confirm if all bots exited
        checkActiveSessions();
      } catch (err) {
        console.error("[LiveMeetingModal] Error parsing bot_stopped event:", err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, []);

  // Fetch user projects when active session exists or modal opens
  useEffect(() => {
    if (!activeSessionData) return;

    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/projects`, { credentials: "include" });
        if (res.ok) {
          const list: ProjectItem[] = await res.json();
          setProjects(list);
          setSelectedProjectId(prev => {
            // If previous selection is valid and in list, keep it
            if (prev && list.some(p => p.id === prev)) return prev;
            // Otherwise reset to first project
            return list.length > 0 ? list[0].id : "";
          });
        }
      } catch (err) {
        console.error("[LiveMeetingModal] Error fetching projects list:", err);
      }
    })();
  }, [activeSessionData]);

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
          sessionId: activeSessionData?.sessionId,
          projectId: selectedProjectId
        })
      });

      const targetId = selectedProjectId;
      const sessionId = activeSessionData?.sessionId;
      setIsModalOpen(false);
      setJoining(false);

      // Redirect to live transcript page for the chosen project with ?sessionId=
      if (sessionId) {
        router.push(`/projects/${targetId}/meeting?sessionId=${sessionId}`);
      } else {
        router.push(`/projects/${targetId}/meeting`);
      }
    } catch (err) {
      console.error("[LiveMeetingModal] Error linking session to project:", err);
      setJoining(false);
      const sessionId = activeSessionData?.sessionId;
      setIsModalOpen(false);
      if (sessionId) {
        router.push(`/projects/${selectedProjectId}/meeting?sessionId=${sessionId}`);
      } else {
        router.push(`/projects/${selectedProjectId}/meeting`);
      }
    }
  }

  if (!activeSessionData) return null;

  return (
    <>
      {/* Persistent Bottom-Right Corner Floating Indicator */}
      <div className="fixed bottom-6 right-6 z-50 animate-in fade-in slide-in-from-bottom-5 duration-300">
        <div
          onClick={() => setIsModalOpen(true)}
          className="group flex items-center gap-3.5 rounded-2xl border border-emerald-500/40 bg-surface/95 p-3.5 pl-4 pr-5 shadow-2xl backdrop-blur-xl transition-all duration-200 hover:border-emerald-500 hover:bg-surface hover:shadow-emerald-500/10 cursor-pointer"
        >
          {/* Animated Pulsing Live Dot */}
          <span className="relative flex h-3.5 w-3.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-emerald-500" />
          </span>

          <div className="flex flex-col pr-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-500 flex items-center gap-1">
                Live Meeting Active
              </span>
              <Badge tone="success" className="text-[10px] py-0 px-1.5 font-semibold">
                {activeSessionData.botType || "google-meet"}
              </Badge>
            </div>
            <p className="max-w-[220px] truncate text-xs font-semibold text-ink">
              {activeSessionData.title || activeSessionData.botName || "Calendar Meeting Room"}
            </p>
          </div>

          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500 transition-colors group-hover:bg-emerald-500 group-hover:text-white">
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </div>
        </div>
      </div>

      {/* Project Selection Modal Dialog */}
      <Modal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
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
                <Badge tone="success">{activeSessionData.botType || "google-meet"}</Badge>
              </h3>
              <p className="text-xs text-ink-mute">
                Bot is currently inside the meeting room capturing live transcript.
              </p>
            </div>
          </div>
          <button
            onClick={() => setIsModalOpen(false)}
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
              {activeSessionData.title || activeSessionData.botName || "Calendar Meeting Session"}
            </p>
            {activeSessionData.meetingUrl && (
              <p className="text-xs text-ink-soft truncate font-mono">
                {activeSessionData.meetingUrl}
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
          <Button variant="ghost" size="sm" onClick={() => setIsModalOpen(false)}>
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
    </>
  );
}
