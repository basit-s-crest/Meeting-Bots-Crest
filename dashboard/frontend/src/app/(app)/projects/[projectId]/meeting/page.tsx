"use client";

import { use, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import {
  ArrowLeft, Play, Square, Volume2, Layers, Wifi, WifiOff, X, Plus, Mail,
  Calendar, Check, AlertTriangle, Loader2
} from "lucide-react";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Input";
import { LiveQAOverlay, QAPair } from "@/components/LiveQAOverlay";

interface TranscriptLine {
  lineId?: string;
  segmentId?: number;
  speaker: string;
  text: string;
  timestamp?: string;
  /** Accumulated finalized text segments for this speaker block */
  committedText: string;
  /** The current interim (non-final) text being streamed */
  interimText: string;
  isFinal?: boolean;
  /** True until a confident speaker name resolves for this segment */
  provisional?: boolean;
}

import { BACKEND_URL, apiFetch } from "@/context/AuthContext";

export default function MeetingBotPage({ params }: { params?: Promise<{ projectId: string }> | { projectId: string } }) {
  const routeParams = useParams();
  const rawProjectId = typeof routeParams?.projectId === "string" ? routeParams.projectId : Array.isArray(routeParams?.projectId) ? routeParams.projectId[0] : "";
  const resolvedParams = params && typeof (params as any).then === 'function' ? use(params as Promise<{ projectId: string }>) : (params as { projectId: string });
  const projectId = rawProjectId || resolvedParams?.projectId || "";
  const router = useRouter();

  const [botType, setBotType] = useState("google-meet");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [botName, setBotName] = useState("Antigravity Transcriber");
  const [folderUrl, setFolderUrl] = useState("");
  const [headless, setHeadless] = useState(true);
  const [attendeeEmails, setAttendeeEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [botStatus, setBotStatus] = useState<"idle" | "starting" | "joining" | "capturing" | "stopping" | "stopped">("idle");
  const [activeSpeaker, setActiveSpeaker] = useState("No active speaker");
  const [liveLines, setLiveLines] = useState<TranscriptLine[]>([]);
  const [qaHistory, setQaHistory] = useState<QAPair[]>([]);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [highlightedLineId, setHighlightedLineId] = useState<string | null>(null);
  const [exitReasonMessage, setExitReasonMessage] = useState<string | null>(null);

  const getMeetingEndMessage = (reason?: string) => {
    switch (reason) {
      case 'host_ended':
        return "Meeting ended by host.";
      case 'dashboard_leave':
        return "Dashboard-initiated leave.";
      case 'chat_command_leave':
        return "Chat-command-initiated leave.";
      case 'unknown':
      default:
        return "Session ended unexpectedly.";
    }
  };

  // Live scheduling-approval state
  const [pendingProposal, setPendingProposal] = useState<{
    id: string;
    title: string;
    date?: string;
    time?: string;
    timezone?: string;
    raw_mention?: string;
    token: string;
    status: string;
  } | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);

  // Poll for pending scheduling proposals while a session is live.
  useEffect(() => {
    if (!activeSessionId || botStatus === "idle" || botStatus === "stopped") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/approvals/live?sessionId=${activeSessionId}`, {
          credentials: "include"
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.proposal && data.proposal.status === "pending_organizer") {
          setPendingProposal(data.proposal);
        } else if (data.proposal && data.proposal.status !== "pending_organizer") {
          // Already handled; hide the banner.
          setPendingProposal(null);
        }
      } catch {
        // ignore transient polling errors
      }
    };

    poll();
    const interval = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeSessionId, botStatus]);

  const handleOrganizerApprove = async () => {
    if (!pendingProposal) return;
    setApprovalLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/approvals/organizer/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId: activeSessionId })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to approve proposal");
      }
      setPendingProposal(null);
      alert("Approval sent to the Google Meet chat. Attendees can now approve via the link.");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to approve proposal");
    } finally {
      setApprovalLoading(false);
    }
  };

  const handleOrganizerReject = async () => {
    if (!pendingProposal) return;
    setApprovalLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/approvals/organizer/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId: activeSessionId })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to reject proposal");
      }
      setPendingProposal(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to reject proposal");
    } finally {
      setApprovalLoading(false);
    }
  };

  const handleAddEmail = (rawEmail?: string) => {
    const target = (rawEmail !== undefined ? rawEmail : emailInput).trim().toLowerCase();
    if (!target) return;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(target)) {
      setEmailError("Invalid email format (e.g. name@example.com)");
      return;
    }

    if (attendeeEmails.includes(target)) {
      setEmailError("Email address already added");
      return;
    }

    setAttendeeEmails(prev => [...prev, target]);
    setEmailInput("");
    setEmailError(null);
  };

  const handleRemoveEmail = (emailToRemove: string) => {
    setAttendeeEmails(prev => prev.filter(e => e !== emailToRemove));
  };

  const handleEmailKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      handleAddEmail();
    }
  };

  const handleJumpToLine = (lineId: string) => {
    setHighlightedLineId(lineId);
    const el = document.getElementById(`transcript-line-${lineId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setTimeout(() => setHighlightedLineId(null), 3000);
  };

  const socketRef = useRef<WebSocket | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);
  const visualizerTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const eventSource = new EventSource(`${BACKEND_URL}/api/events/subscribe`, {
      withCredentials: true,
    });

    eventSource.addEventListener("bot_stopped", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (activeSessionId && data.sessionId === activeSessionId) {
          const msg = getMeetingEndMessage(data.reason);
          setExitReasonMessage(msg);
          setBotStatus("idle");
          disconnectWebSocket();
        }
      } catch (err) {
        console.error("Failed to parse bot_stopped SSE event:", err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, [activeSessionId]);

  useEffect(() => {
    // Auto-detect and connect to active session running on backend
    // Session check on mount
    (async () => {
      try {
        const searchParams = new URLSearchParams(window.location.search);
        const urlSessionId = searchParams.get("sessionId");

        if (urlSessionId) {
          const res = await apiFetch(`${BACKEND_URL}/api/sessions/${urlSessionId}`);
          if (res.ok) {
            const data = await res.json();
            const session = data.session || data;
            if (session && session.sessionId) {
              setActiveSessionId(session.sessionId);
              setBotStatus(session.status || "capturing");
              if (session.botType) setBotType(session.botType);
              if (session.meetingUrl) setMeetingUrl(session.meetingUrl);
              if (session.botName) setBotName(session.botName);
              connectWebSocket(session.sessionId);
              return;
            }
          }
        }

        // Fallback: check active sessions list
        const res = await apiFetch(`${BACKEND_URL}/api/sessions`);
        if (res.ok) {
          const data = await res.json();
          if (data.sessions && data.sessions.length > 0) {
            const active = data.sessions.find((s: any) => s.projectId === projectId) || data.sessions[0];
            if (active && active.sessionId) {
              setActiveSessionId(active.sessionId);
              setBotStatus(active.status || "capturing");
              if (active.botType) setBotType(active.botType);
              if (active.meetingUrl) setMeetingUrl(active.meetingUrl);
              if (active.botName) setBotName(active.botName);
              connectWebSocket(active.sessionId);
            }
          }
        }
      } catch (err) {
        console.error("[Meeting Page] Error checking active session on mount:", err);
      }
    })();

    return () => {
      disconnectWebSocket();
    };
  }, [projectId]);


  useEffect(() => {
    const container = transcriptContainerRef.current;
    if (!container) return;

    if (wasNearBottomRef.current) {
      if (transcriptEndRef.current) {
        transcriptEndRef.current.scrollIntoView({ behavior: "smooth" });
      }
      setShowJumpButton(false);
    } else {
      if (liveLines.length > 0) {
        setShowJumpButton(true);
      }
    }
  }, [liveLines]);

  const handleScroll = () => {
    const container = transcriptContainerRef.current;
    if (!container) return;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    if (isNearBottom) {
      setShowJumpButton(false);
      wasNearBottomRef.current = true;
    }
  };

  const handleJumpToLatest = () => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
    setShowJumpButton(false);
    wasNearBottomRef.current = true;
  };



  function disconnectWebSocket() {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    if (visualizerTimerRef.current) {
      clearInterval(visualizerTimerRef.current);
      visualizerTimerRef.current = null;
    }
  };

  const handleLaunchBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!meetingUrl.trim() || botStatus !== "idle") return;

    setBotStatus("starting");
    setExitReasonMessage(null);
    setLiveLines([]);
    setQaHistory([]);
    wasNearBottomRef.current = true;
    setActiveSpeaker("Connecting…");

    try {
      const res = await apiFetch(`${BACKEND_URL}/api/sessions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          botType,
          meetingUrl,
          botName,
          isHeadless: headless,
          googleDriveFolderId: folderUrl || null,
          projectId,
          attendeeEmails
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start session");
      }

      const data = await res.json();
      setActiveSessionId(data.sessionId);
      connectWebSocket(data.sessionId);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Launch failed");
      setBotStatus("idle");
      setActiveSpeaker("No active speaker");
    }
  };

  const connectWebSocket = (sessionId: string) => {
    disconnectWebSocket();

    const wsUrl = `ws://localhost:3000/ws/transcripts?sessionId=${sessionId}`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => console.log("[WebSocket] Connected to live audio stream");

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "status") {
          setBotStatus(msg.data.status);
        } else if (msg.type === "transcript") {
          const segmentId = msg.data.segmentId;
          const speaker = msg.data.speaker || "Unknown";
          const text = msg.data.text || "";
          const isFinal = msg.data.isFinal !== false;
          const provisional = msg.data.provisional === true;

          // Before updating lines, set wasNearBottomRef based on container scroll state
          const container = transcriptContainerRef.current;
          if (container) {
            wasNearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
          } else {
            wasNearBottomRef.current = true;
          }

          setLiveLines(prev => {
            const lastIdx = prev.length - 1;
            const lastBlock = lastIdx >= 0 ? prev[lastIdx] : null;

            // Group by speaker turn: if the incoming chunk belongs to the SAME
            // speaker as the current (last) box, append to that one box instead
            // of spawning a new one. Only start a new box when the speaker
            // changes. Provisional "speaker_N" ids differ per segment, so they
            // stay separate until a real name resolves — then same-name chunks
            // merge into the one box (repaint by segmentId still applies).
            const sameSpeaker = lastBlock && lastBlock.speaker === speaker;

            if (sameSpeaker) {
              const updated = [...prev];
              const currentBlock = { ...updated[lastIdx] };
              currentBlock.speaker = speaker;
              currentBlock.provisional = provisional;
              currentBlock.isFinal = isFinal;
              if (isFinal) {
                currentBlock.committedText = currentBlock.committedText
                  ? currentBlock.committedText + " " + text
                  : text;
                currentBlock.interimText = "";
              } else {
                currentBlock.committedText = currentBlock.committedText || "";
                currentBlock.interimText = text;
              }
              currentBlock.text = currentBlock.interimText
                ? currentBlock.committedText + " " + currentBlock.interimText
                : currentBlock.committedText;
              // Keep the resolved segmentId so later repaints land on this box.
              if (segmentId != null) currentBlock.segmentId = segmentId;
              updated[lastIdx] = currentBlock;
              return updated;
            }

            // Different speaker (or first block) — start a new box.
            const newBlock: TranscriptLine = {
              segmentId: segmentId ?? prev.length,
              speaker,
              committedText: isFinal ? text : "",
              interimText: isFinal ? "" : text,
              text,
              isFinal,
              provisional,
              timestamp: new Date().toISOString()
            };
            return [...prev, newBlock];
          });

          setActiveSpeaker(speaker);
        } else if (msg.type === "visualizer") {
          const visBars = document.querySelectorAll(".vis-bar-element");
          visBars.forEach((bar) => {
            const el = bar as HTMLElement;
            const scale = 0.3 + (msg.data.amplitude || 0) * 1.5;
            el.style.transform = `scaleY(${Math.min(scale, 1.8)})`;
          });
        } else if (msg.type === "qa_answer_chunk") {
          const { id, chunk } = msg.data;
          setQaHistory(prev => prev.map(item => {
            if (item.id === id) {
              return {
                ...item,
                answer: item.answer + chunk,
                isStreaming: true
              };
            }
            return item;
          }));
        } else if (msg.type === "qa_answer_complete") {
          const { id, fullAnswer, citations } = msg.data;
          setQaHistory(prev => prev.map(item => {
            if (item.id === id) {
              return {
                ...item,
                answer: fullAnswer || item.answer,
                citations: Array.isArray(citations) ? citations : [],
                isStreaming: false
              };
            }
            return item;
          }));
        } else if (msg.type === "qa_error") {
          const { id, error } = msg.data;
          setQaHistory(prev => prev.map(item => {
            if (item.id === id) {
              return {
                ...item,
                isStreaming: false,
                error: error || "Failed to generate answer"
              };
            }
            return item;
          }));
        }
      } catch (err) {
        console.error("[WebSocket] Message parsing error", err);
      }
    };

    ws.onclose = () => {
      console.log("[WebSocket] Connection closed");
      setBotStatus("idle");
      setActiveSpeaker("No active speaker");
    };
  };

  const handleStopBot = async () => {
    if (!activeSessionId) return;
    setBotStatus("stopping");

    try {
      const res = await apiFetch(`${BACKEND_URL}/api/sessions/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId: activeSessionId, projectId })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Stop request failed");
      }

      disconnectWebSocket();
      setActiveSessionId(null);
      setBotStatus("idle");
      setActiveSpeaker("No active speaker");

      alert("Session completed. AI summaries are generating in the background!");
      router.push(`/projects/${projectId}`);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to stop bot");
      setBotStatus("capturing");
    }
  };

  const isCapturing = botStatus === "capturing";

  return (
    <Container className="py-6 max-w-none px-4 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link
            href={`/projects/${projectId}`}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
              Bot orchestrator
            </h1>
          </div>
        </div>
        {botStatus !== "idle" && botStatus !== "stopped" ? (
          <Badge tone={botStatus === "capturing" ? "success" : "warning"}>
            <Wifi className="h-3.5 w-3.5 animate-pulse" />{" "}
            {botStatus === "capturing"
              ? "Capturing Live Audio"
              : botStatus === "joining"
              ? "Bot Joining..."
              : botStatus === "starting"
              ? "Bot Starting..."
              : botStatus === "stopping"
              ? "Stopping Bot..."
              : "Active connection"}
          </Badge>
        ) : (
          <Badge tone="neutral">
            <WifiOff className="h-3.5 w-3.5" /> Disconnected
          </Badge>
        )}
      </div>

      {pendingProposal && (
        <div className="mt-6 rounded-2xl border border-brand-200 bg-brand-50 p-5 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
                <Calendar className="h-5 w-5" />
              </span>
              <div>
                <h3 className="font-display text-base font-bold text-ink">
                  Scheduling request detected
                </h3>
                <p className="mt-0.5 text-sm font-semibold text-brand-700">
                  {pendingProposal.title || "Follow-up Meeting"}
                </p>
                {(pendingProposal.date || pendingProposal.time) && (
                  <p className="mt-0.5 text-xs text-ink-soft">
                    {[pendingProposal.date, pendingProposal.time].filter(Boolean).join(" at ")}
                    {pendingProposal.timezone ? ` (${pendingProposal.timezone})` : ""}
                  </p>
                )}
                {pendingProposal.raw_mention && (
                  <p className="mt-2 rounded border-l-4 border-brand-500 bg-surface p-2 text-xs italic text-ink-soft">
                    &ldquo;{pendingProposal.raw_mention}&rdquo;
                  </p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOrganizerReject}
                disabled={approvalLoading}
              >
                Reject
              </Button>
              <Button
                size="sm"
                onClick={handleOrganizerApprove}
                disabled={approvalLoading}
              >
                {approvalLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Approve & send to chat
              </Button>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-ink-mute">
            Approving will post the proposal into the Google Meet central chat so attendees can approve via the link.
          </p>
        </div>
      )}

      {exitReasonMessage && (
        <div className="mt-4 flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 font-medium text-amber-600 dark:text-amber-400">
          <span>{exitReasonMessage}</span>
          <button onClick={() => setExitReasonMessage(null)} className="cursor-pointer text-xs underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Config */}
        <section className="space-y-6 lg:col-span-3">
          <Card className="p-6">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-ink">
              <Layers className="h-5 w-5 text-brand-600" />
              Bot settings
            </h2>

            <form onSubmit={handleLaunchBot} className="space-y-4">
              <Select
                id="bot-type"
                label="Meeting platform"
                value={botType}
                onChange={(e) => setBotType(e.target.value)}
                disabled={botStatus !== "idle"}
              >
                <option value="google-meet">Google Meet</option>
                <option value="zoom">Zoom</option>
                <option value="teams">Microsoft Teams</option>
              </Select>

              <Input
                id="meeting-url"
                label="Meeting URL"
                type="url"
                required
                placeholder="https://meet.google.com/…"
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
                disabled={botStatus !== "idle"}
              />

              <Input
                id="bot-name"
                label="Bot name"
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                disabled={botStatus !== "idle"}
              />

              <Input
                id="folder-url"
                label="Google Drive folder URL (optional)"
                type="url"
                placeholder="https://drive.google.com/…"
                value={folderUrl}
                onChange={(e) => setFolderUrl(e.target.value)}
                disabled={botStatus !== "idle"}
              />

              {/* Attendee Emails (Additive) */}
              <div className="space-y-1.5 pt-1">
                <label htmlFor="attendee-email-input" className="block text-sm font-medium text-ink">
                  Attendee report emails (optional)
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="attendee-email-input"
                      type="email"
                      placeholder="attendee@company.com"
                      value={emailInput}
                      onChange={(e) => {
                        setEmailInput(e.target.value);
                        if (emailError) setEmailError(null);
                      }}
                      onKeyDown={handleEmailKeyDown}
                      disabled={botStatus !== "idle"}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => handleAddEmail()}
                    disabled={botStatus !== "idle" || !emailInput.trim()}
                    className="shrink-0"
                  >
                    <Plus className="h-4 w-4" /> Add
                  </Button>
                </div>
                {emailError && (
                  <p className="text-xs font-medium text-red-500">{emailError}</p>
                )}
                {attendeeEmails.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 pt-1">
                    {attendeeEmails.map((email) => (
                      <span
                        key={email}
                        className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 border border-brand-200"
                      >
                        <Mail className="h-3 w-3 text-brand-500" />
                        {email}
                        {botStatus === "idle" && (
                          <button
                            type="button"
                            onClick={() => handleRemoveEmail(email)}
                            className="ml-0.5 text-brand-400 hover:text-brand-700"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-3 pt-1">
                <input
                  type="checkbox"
                  id="headless"
                  checked={headless}
                  onChange={(e) => setHeadless(e.target.checked)}
                  disabled={botStatus !== "idle"}
                  className="h-4 w-4 rounded border-border-strong text-brand-600 focus:ring-brand-500"
                />
                <span className="select-none text-sm text-ink-soft">Run headless (recommended)</span>
              </label>

              {botStatus === "idle" ? (
                <Button type="submit" className="mt-4 w-full" size="lg">
                  <Play className="h-4 w-4" />
                  Launch bot & stream
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="danger"
                  onClick={handleStopBot}
                  disabled={botStatus === "stopping"}
                  className="mt-4 w-full"
                  size="lg"
                >
                  <Square className="h-4 w-4" />
                  Stop bot session
                </Button>
              )}
            </form>
          </Card>


        </section>

        {/* Monitor */}
        <section className="space-y-6 lg:col-span-9">
          <Card className="flex flex-col items-center justify-between gap-6 p-6 sm:flex-row">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 font-display text-2xl font-bold text-brand-600">
                {activeSpeaker === "Connecting…"
                  ? "📡"
                  : activeSpeaker !== "No active speaker"
                    ? activeSpeaker.substring(0, 2).toUpperCase()
                    : "🤖"}
              </div>
              <div>
                <h3 className="font-display text-lg font-bold text-ink">{activeSpeaker}</h3>
                <p className="flex items-center gap-1 text-xs text-ink-mute">
                  Status: <span className="font-semibold capitalize text-brand-600">{botStatus}</span>
                </p>
              </div>
            </div>

            <div className="flex h-12 items-end gap-1.5">
              {[...Array(10)].map((_, i) => (
                <div
                  key={i}
                  className={`vis-bar-element w-1.5 rounded-full bg-brand-500 ${isCapturing ? "vis-bar-anim" : ""}`}
                  style={{
                    height: "100%",
                    transform: "scaleY(0.2)",
                    animationDelay: `${i * 0.1}s`
                  }}
                />
              ))}
            </div>
          </Card>

          {/* Sub-grid for Live Transcript (Column A) and Live Q&A (Column B) */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Column A: Live Transcript Stream Card */}
            <Card className="relative flex flex-col p-6 min-h-[440px] max-h-[calc(100vh-280px)] lg:col-span-7">
              <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-ink">
                <Volume2 className="h-5 w-5 text-brand-600" />
                Live transcript stream
              </h3>

              <div
                ref={transcriptContainerRef}
                onScroll={handleScroll}
                className="mb-4 flex-1 space-y-4 overflow-y-auto pr-1 scroll-smooth"
              >
                {liveLines.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                    <Play className="h-10 w-10 animate-pulse text-ink-faint" />
                    <p className="text-sm text-ink-mute">
                      Speech will stream here once the bot joins the meeting.
                    </p>
                  </div>
                ) : (
                  liveLines.map((line, idx) => (
                    <div
                      key={line.lineId || idx}
                      id={`transcript-line-${line.lineId}`}
                      className={`border bg-surface-2/50 rounded-xl p-4 transition-all duration-300 ${
                        highlightedLineId === line.lineId ? "ring-2 ring-brand-500 bg-brand-50/80 shadow-md border-brand-300" : "border-border"
                      } ${line.isFinal === false ? "opacity-70 italic border-dashed border-brand-300" : ""}`}
                    >
                      <span className="mb-1 block text-xs font-bold text-brand-600">
                        {line.speaker}
                        {line.provisional && (
                          <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700">
                            identifying…
                          </span>
                        )}
                      </span>
                      <p className="text-sm leading-relaxed text-ink-soft">
                        {line.committedText}
                        {line.interimText && (
                          <span className="text-ink-faint italic">{line.committedText ? " " : ""}{line.interimText}</span>
                        )}
                      </p>
                    </div>
                  ))
                )}
                <div ref={transcriptEndRef} />
              </div>

              {showJumpButton && (
                <button
                  type="button"
                  onClick={handleJumpToLatest}
                  className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 text-xs font-semibold shadow-lg transition-all flex items-center gap-1.5 z-10 animate-bounce"
                >
                  <span>↓ Jump to latest</span>
                </button>
              )}
            </Card>

            {/* Column B: Live Q&A Overlay Card */}
            <LiveQAOverlay
              qaHistory={qaHistory}
              onCitationClick={(lineId) => handleJumpToLine(lineId)}
              className="min-h-[440px] max-h-[calc(100vh-280px)] lg:col-span-5"
              onSendQuestion={(questionText) => {
                if (!questionText.trim()) return;
                const id = `qa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                const newQA: QAPair = {
                  id,
                  question: questionText.trim(),
                  answer: "",
                  isStreaming: true,
                  timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                };
                setQaHistory(prev => [...prev, newQA]);

                if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
                  const contextOverride = liveLines
                    .map(l => `[${l.lineId} | ${l.timestamp || 'Live'} | ${l.speaker}]: ${l.committedText}`)
                    .filter(t => t.trim().length > 0)
                    .join("\n");

                  socketRef.current.send(JSON.stringify({
                    type: "qa_question",
                    data: {
                      id,
                      question: questionText.trim(),
                      contextOverride
                    }
                  }));
                } else {
                  setQaHistory(prev => prev.map(item => {
                    if (item.id === id) {
                      return {
                        ...item,
                        isStreaming: false,
                        error: "WebSocket is not connected. Please start a bot session."
                      };
                    }
                    return item;
                  }));
                }
              }}
              disabled={botStatus === "idle"}
            />
          </div>
        </section>
      </div>
    </Container>
  );
}
