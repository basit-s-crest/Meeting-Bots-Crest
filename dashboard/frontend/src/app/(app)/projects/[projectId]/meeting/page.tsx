"use client";

import { use, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Play, Square, Volume2, Layers, Wifi, WifiOff
} from "lucide-react";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Input";

interface TranscriptLine {
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

const BACKEND_URL = "http://localhost:3000";

const originalFetch = typeof window !== "undefined" ? window.fetch : null;
const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (!originalFetch) return Promise.reject(new Error("fetch called on server"));
  return originalFetch(input, {
    ...init,
    credentials: "include"
  });
};

export default function MeetingBotPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const router = useRouter();

  const [botType, setBotType] = useState("google-meet");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [botName, setBotName] = useState("Antigravity Transcriber");
  const [folderUrl, setFolderUrl] = useState("");
  const [headless, setHeadless] = useState(true);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [botStatus, setBotStatus] = useState<"idle" | "starting" | "joining" | "capturing" | "stopping" | "stopped">("idle");
  const [activeSpeaker, setActiveSpeaker] = useState("No active speaker");
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [driveConnecting, setDriveConnecting] = useState(true);
  const [isCalendarConnected, setIsCalendarConnected] = useState(false);
  const [calendarConnecting, setCalendarConnecting] = useState(true);

  const [liveLines, setLiveLines] = useState<TranscriptLine[]>([]);
  const [showJumpButton, setShowJumpButton] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);
  const visualizerTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    checkGoogleDriveStatus();
    checkGoogleCalendarStatus();
    return () => {
      disconnectWebSocket();
    };
  }, []);

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


  function checkGoogleDriveStatus() {
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/auth/google/status`);
        if (res.ok) {
          const data = await res.json();
          setIsDriveConnected(data.connected);
        }
      } catch {
      } finally {
        setDriveConnecting(false);
      }
    })();
  }

  function checkGoogleCalendarStatus() {
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/calendar/auth/status`);
        if (res.ok) {
          const data = await res.json();
          setIsCalendarConnected(data.connected);
        }
      } catch {
      } finally {
        setCalendarConnecting(false);
      }
    })();
  }

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
    setLiveLines([]);
    wasNearBottomRef.current = true;
    setActiveSpeaker("Connecting…");

    try {
      const res = await fetch(`${BACKEND_URL}/api/sessions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botType,
          meetingUrl,
          botName,
          isHeadless: headless,
          googleDriveFolderId: folderUrl || null,
          projectId
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
      const res = await fetch(`${BACKEND_URL}/api/sessions/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: activeSessionId })
      });
      if (!res.ok) throw new Error("Stop request failed");

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
    <Container className="py-8">
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
            <p className="text-sm text-ink-mute">
              Configure platform joins and monitor live speech streams
            </p>
          </div>
        </div>
        {botStatus !== "idle" ? (
          <Badge tone="success">
            <Wifi className="h-3.5 w-3.5 animate-pulse" /> Active connection
          </Badge>
        ) : (
          <Badge tone="neutral">
            <WifiOff className="h-3.5 w-3.5" /> Disconnected
          </Badge>
        )}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Config */}
        <section className="space-y-6">
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Card className="flex flex-col justify-between p-4">
              <div className="flex items-center gap-2">
                <span className="text-base shrink-0">📁</span>
                <h4 className="text-xs font-semibold text-ink">Google Drive auth</h4>
              </div>
              <div className="mt-3">
                {driveConnecting ? (
                  <span className="text-xs text-ink-mute">Checking…</span>
                ) : isDriveConnected ? (
                  <Badge tone="success">Connected</Badge>
                ) : (
                  <a href={`${BACKEND_URL}/api/auth/google`} className="inline-block text-xs font-semibold text-brand-600 hover:text-brand-700">
                    Connect
                  </a>
                )}
              </div>
            </Card>

            <Card className="flex flex-col justify-between p-4">
              <div className="flex items-center gap-2">
                <span className="text-base shrink-0">📅</span>
                <h4 className="text-xs font-semibold text-ink">Google Calendar auth</h4>
              </div>
              <div className="mt-3">
                {calendarConnecting ? (
                  <span className="text-xs text-ink-mute">Checking…</span>
                ) : isCalendarConnected ? (
                  <Badge tone="success">Connected</Badge>
                ) : (
                  <a href={`${BACKEND_URL}/api/calendar/auth`} className="inline-block text-xs font-semibold text-brand-600 hover:text-brand-700">
                    Connect
                  </a>
                )}
              </div>
            </Card>
          </div>
        </section>

        {/* Monitor */}
        <section className="space-y-6 lg:col-span-2">
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

          <Card className="relative flex h-[52vh] flex-col p-6">
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
                    key={idx}
                    className={`border border-border bg-surface-2/50 rounded-xl p-4 transition-all duration-200 ${
                      line.isFinal === false ? "opacity-70 italic border-dashed border-brand-300" : ""
                    }`}
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
                className="absolute bottom-10 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 text-xs font-semibold shadow-lg transition-all flex items-center gap-1.5 z-10 animate-bounce"
              >
                <span>↓ Jump to latest</span>
              </button>
            )}
          </Card>
        </section>
      </div>
    </Container>
  );
}
