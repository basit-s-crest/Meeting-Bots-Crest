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
  speaker: string;
  text: string;
  timestamp?: string;
  /** Accumulated finalized text segments for this speaker block */
  committedText: string;
  /** The current interim (non-final) text being streamed */
  interimText: string;
}

const BACKEND_URL = "http://localhost:3000";

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

  const [liveLines, setLiveLines] = useState<TranscriptLine[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const visualizerTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    checkGoogleDriveStatus();
    return () => {
      disconnectWebSocket();
    };
  }, []);

  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [liveLines]);

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
          const speaker = msg.data.speaker || "Unknown";
          const text = msg.data.text || "";
          const isFinal = msg.data.isFinal || false;

          setLiveLines(prev => {
            const lastLine = prev.length > 0 ? prev[prev.length - 1] : null;

            if (lastLine && lastLine.speaker === speaker) {
              // Same speaker — update the current block
              const updated = [...prev];
              const currentBlock = { ...updated[updated.length - 1] };

              if (isFinal) {
                // Commit this text permanently and clear interim
                currentBlock.committedText = currentBlock.committedText
                  ? currentBlock.committedText + " " + text
                  : text;
                currentBlock.interimText = "";
              } else {
                // Update only the interim (in-progress) portion
                currentBlock.interimText = text;
              }

              currentBlock.text = currentBlock.interimText
                ? currentBlock.committedText + " " + currentBlock.interimText
                : currentBlock.committedText;

              updated[updated.length - 1] = currentBlock;
              return updated;
            } else {
              // New speaker — start a new block
              const newBlock: TranscriptLine = {
                speaker,
                committedText: isFinal ? text : "",
                interimText: isFinal ? "" : text,
                text,
                timestamp: new Date().toISOString()
              };
              return [...prev, newBlock];
            }
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

          <Card className="flex items-center justify-between p-5">
            <div className="flex items-center gap-3">
              <span className="text-xl">📁</span>
              <div>
                <h4 className="text-sm font-semibold text-ink">Google Drive auth</h4>
                <p className="text-[10px] text-ink-faint">Auto sync to cloud drives</p>
              </div>
            </div>
            {driveConnecting ? (
              <span className="text-xs text-ink-mute">Checking…</span>
            ) : isDriveConnected ? (
              <Badge tone="success">Connected</Badge>
            ) : (
              <a href={`${BACKEND_URL}/api/auth/google`} className="text-sm font-semibold text-brand-600 hover:text-brand-700">
                Connect
              </a>
            )}
          </Card>
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

          <Card className="flex h-[52vh] flex-col p-6">
            <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-ink">
              <Volume2 className="h-5 w-5 text-brand-600" />
              Live transcript stream
            </h3>

            <div className="mb-4 flex-1 space-y-4 overflow-y-auto pr-1 scroll-smooth">
              {liveLines.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                  <Play className="h-10 w-10 animate-pulse text-ink-faint" />
                  <p className="text-sm text-ink-mute">
                    Speech will stream here once the bot joins the meeting.
                  </p>
                </div>
              ) : (
                liveLines.map((line, idx) => (
                  <div key={idx} className="border border-border bg-surface-2/50 rounded-xl p-4">
                    <span className="mb-1 block text-xs font-bold text-brand-600">{line.speaker}</span>
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
          </Card>
        </section>
      </div>
    </Container>
  );
}
