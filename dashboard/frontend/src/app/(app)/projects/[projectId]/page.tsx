"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, FileText, Calendar, MessageSquare, Play,
  Send, Sparkles, Download, Eye, Clock, CheckCircle2, AlertCircle, X
} from "lucide-react";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";

interface TranscriptLine {
  speaker: string;
  text: string;
  timestamp?: string;
}

interface Session {
  fileName: string;
  sessionId: string;
  created: string;
  size: number;
  isDbBacked: boolean;
  botType: string;
  status: string;
  transcriptFileUrl?: string;
  reportFileUrl?: string;
}

interface ChatMessage {
  sender: "user" | "bot";
  text: string;
  citations?: Array<{
    sessionId: string;
    meetingDate: string;
    platform: string;
    snippet: string;
  }>;
  usedFallback?: boolean;
  answeredVia?: "vector_search" | "project_transcript_fallback" | string;
}

interface ProjectListItem {
  id: string;
  name: string;
  description: string;
}

interface SchedulingIntent {
  title?: string;
  date?: string;
  time?: string;
  zoom_link?: string;
  raw_mention?: string;
  timezone?: string;
}

interface SchedulingData {
  scheduling_detected: boolean;
  scheduling?: SchedulingIntent | null;
  status?: string;
}

const BACKEND_URL = "http://localhost:3000";

export default function ProjectWorkspacePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const [project, setProject] = useState<ProjectListItem | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [activeTranscript, setActiveTranscript] = useState<{ sessionId: string; lines: TranscriptLine[] } | null>(null);
  const [activeReport, setActiveReport] = useState<{
    sessionId: string;
    markdown: string;
    speakerStats: Array<{ speaker: string; percentage: number; talkTime: string }>;
    scheduling: SchedulingData | null;
    filename: string;
  } | null>(null);
  const [loadingModal, setLoadingModal] = useState(false);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { sender: "bot", text: "Hello! I am your Project Knowledge Assistant. Ask me anything about the meetings in this workspace." }
  ]);
  const [question, setQuestion] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const [schedTitle, setSchedTitle] = useState("");
  const [schedDate, setSchedDate] = useState("");
  const [schedTime, setSchedTime] = useState("");
  const [schedZoom, setSchedZoom] = useState("");
  const [schedSuccess, setSchedSuccess] = useState(false);

  useEffect(() => {
    function fetchProjectDetails() {
      (async () => {
        try {
          const res = await fetch(`${BACKEND_URL}/api/projects`);
          if (res.ok) {
            const list: ProjectListItem[] = await res.json();
            const found = list.find((p) => p.id === projectId);
            if (found) setProject(found);
          }
        } catch {
        }
      })();
    }
    function fetchSessions() {
      (async () => {
        try {
          const res = await fetch(`${BACKEND_URL}/api/transcripts?projectId=${projectId}`);
          if (!res.ok) throw new Error("Failed to load project session history");
          const data = await res.json();
          setSessions(data.transcripts || []);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Error connecting to backend");
        } finally {
          setLoading(false);
        }
      })();
    }
    fetchProjectDetails();
    fetchSessions();
  }, [projectId]);

  const handleAskQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || chatLoading) return;

    const userMsg = question.trim();
    setChatMessages(prev => [...prev, { sender: "user", text: userMsg }]);
    setQuestion("");
    setChatLoading(true);

    try {
      const res = await fetch(`${BACKEND_URL}/api/memory/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: userMsg, project_id: projectId }),
      });
      if (!res.ok) throw new Error("Failed to fetch answer");
      const data = await res.json();

      setChatMessages(prev => [...prev, {
        sender: "bot",
        text: data.answer || "No response generated.",
        citations: data.citations || [],
        usedFallback: !!data.usedFallback,
        answeredVia: data.answeredVia || (data.usedFallback ? "project_transcript_fallback" : "vector_search")
      }]);
    } catch (err) {
      setChatMessages(prev => [...prev, {
        sender: "bot",
        text: `Error: ${err instanceof Error ? err.message : "Could not fetch answer."}`
      }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleViewTranscript = async (session: Session) => {
    setLoadingModal(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/transcripts/${session.fileName}`);
      if (!res.ok) throw new Error("Could not download transcript");
      const data = await res.json();
      setActiveTranscript({ sessionId: session.sessionId, lines: data.lines || [] });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not download transcript");
    } finally {
      setLoadingModal(false);
    }
  };

  const handleViewReport = async (session: Session) => {
    setLoadingModal(true);
    setSchedSuccess(false);
    try {
      const res = await fetch(`${BACKEND_URL}/api/transcripts/${session.fileName}/generate-report`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Could not retrieve AI report");
      const data = await res.json();

      const transRes = await fetch(`${BACKEND_URL}/api/transcripts/${session.fileName}`);
      let speakerStats: Array<{ speaker: string; percentage: number; talkTime: string }> = [];
      if (transRes.ok) {
        const transData = await transRes.json();
        const lines = transData.lines || [];
        const totals: Record<string, number> = {};
        lines.forEach((l: TranscriptLine) => {
          totals[l.speaker] = (totals[l.speaker] || 0) + 1;
        });
        const totalLines = lines.length;
        speakerStats = Object.keys(totals).map(sp => ({
          speaker: sp,
          percentage: totalLines > 0 ? Math.round((totals[sp] / totalLines) * 100) : 0,
          talkTime: `${totals[sp]} utterances`
        }));
      }

      setSchedTitle(data.scheduling?.scheduling?.title || "");
      setSchedDate(data.scheduling?.scheduling?.date || "");
      setSchedTime(data.scheduling?.scheduling?.time || "");
      setSchedZoom(data.scheduling?.scheduling?.zoom_link || "");

      setActiveReport({
        sessionId: session.sessionId,
        markdown: data.report || "No summary available.",
        speakerStats,
        scheduling: data.scheduling,
        filename: session.fileName
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not retrieve AI report");
    } finally {
      setLoadingModal(false);
    }
  };

  const handleConfirmSchedule = async () => {
    if (!activeReport) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/calendar/confirm-report-schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: schedTitle,
          zoomLink: schedZoom,
          date: schedDate,
          time: schedTime,
          filename: activeReport.filename
        })
      });
      if (!res.ok) throw new Error("Failed to add calendar event");
      setSchedSuccess(true);

      setActiveReport(prev => {
        if (!prev) return null;
        return {
          ...prev,
          scheduling: prev.scheduling ? {
            ...prev.scheduling,
            status: "confirmed"
          } : null
        };
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to schedule");
    }
  };

  const handleDismissSchedule = async () => {
    if (!activeReport) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/calendar/dismiss-report-schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: activeReport.filename
        })
      });
      if (!res.ok) throw new Error("Failed to dismiss scheduling suggestion");

      setActiveReport(prev => {
        if (!prev) return null;
        return {
          ...prev,
          scheduling: prev.scheduling ? {
            ...prev.scheduling,
            status: "dismissed"
          } : null
        };
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to dismiss");
    }
  };

  const renderMarkdown = (text: string) => {
    return text.split("\n").map((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("### ")) {
        return <h4 key={idx} className="mt-4 mb-2 text-base font-bold text-ink">{trimmed.substring(4)}</h4>;
      }
      if (trimmed.startsWith("## ")) {
        return <h3 key={idx} className="mt-6 mb-3 text-lg font-bold text-ink">{trimmed.substring(3)}</h3>;
      }
      if (trimmed.startsWith("# ")) {
        return <h2 key={idx} className="mt-8 mb-4 text-xl font-bold text-brand-700">{trimmed.substring(2)}</h2>;
      }
      if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
        return <li key={idx} className="mb-1 ml-5 list-disc text-sm text-ink-soft">{trimmed.substring(2)}</li>;
      }
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        const cells = trimmed.split("|").slice(1, -1).map(c => c.trim());
        if (trimmed.includes("---")) return null;
        return (
          <div key={idx} className="grid grid-cols-3 gap-4 border-b border-border py-2 text-sm text-ink-soft">
            {cells.map((c, i) => <span key={i}>{c}</span>)}
          </div>
        );
      }
      return <p key={idx} className="mb-3 text-sm leading-relaxed text-ink-soft">{line}</p>;
    });
  };

  return (
    <Container className="py-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/projects"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
              {project?.name || "Loading project…"}
            </h1>
            <p className="text-sm text-ink-mute">
              {project?.description || "Loading description…"}
            </p>
          </div>
        </div>
        <Link href={`/projects/${projectId}/meeting`}>
          <Button>
            <Play className="h-4 w-4" />
            Launch bot session
          </Button>
        </Link>
      </div>

      {/* Grid */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Sessions */}
        <section className="lg:col-span-2">
          <Card className="flex h-full flex-col p-6">
            <h2 className="mb-5 flex items-center gap-2 text-lg font-semibold text-ink">
              <FileText className="h-5 w-5 text-brand-600" />
              Session history
            </h2>

            {loading ? (
              <div className="py-16 text-center text-ink-mute">Loading sessions…</div>
            ) : error ? (
              <div className="py-16 text-center font-medium text-danger">{error}</div>
            ) : sessions.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-ink-faint">
                  <Clock className="h-6 w-6" />
                </span>
                <p className="text-ink-soft">No bot sessions found for this project.</p>
                <p className="text-xs text-ink-faint">
                  Launch a bot to start capturing meeting data.
                </p>
              </div>
            ) : (
              <div className="max-h-[70vh] flex-1 space-y-3 overflow-y-auto pr-1">
                {sessions.map((session) => (
                  <div
                    key={session.sessionId}
                    className="flex flex-col gap-4 rounded-xl border border-border bg-surface-2/50 p-4 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <div className="mb-1.5 flex items-center gap-2">
                        <Badge tone="brand">{session.botType}</Badge>
                        <span className="text-xs text-ink-faint">
                          {new Date(session.created).toLocaleString()}
                        </span>
                      </div>
                      <h4 className="font-semibold text-ink">
                        Meeting: {session.sessionId.substring(0, 8)}…
                      </h4>
                      <p className="mt-1 flex items-center gap-1 text-xs">
                        {session.status === "completed" ? (
                          <Badge tone="success">
                            <CheckCircle2 className="h-3 w-3" /> Completed
                          </Badge>
                        ) : (
                          <Badge tone="warning">
                            <AlertCircle className="h-3 w-3 animate-pulse" /> Capturing
                          </Badge>
                        )}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleViewTranscript(session)}
                        disabled={loadingModal}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Transcript
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleViewReport(session)}
                        disabled={loadingModal}
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        AI summary
                      </Button>
                      {session.reportFileUrl && (
                        <a
                          href={`${BACKEND_URL}/transcripts/${session.botType}_${session.sessionId}_report.docx`}
                          download
                          className="inline-flex items-center gap-1 rounded-lg border border-success/30 bg-success-soft px-3 py-1.5 text-xs font-semibold text-success transition-colors hover:brightness-95"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Word
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section>

        {/* Chat */}
        <section>
          <Card className="flex h-full max-h-[85vh] flex-col p-6">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-ink">
              <MessageSquare className="h-5 w-5 text-brand-600" />
              Project AI chat
            </h2>

            <div className="mb-4 min-h-[300px] flex-1 space-y-4 overflow-y-auto pr-1">
              {chatMessages.map((msg, idx) => (
                <div key={idx} className={`flex flex-col ${msg.sender === "user" ? "items-end" : "items-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                      msg.sender === "user"
                        ? "rounded-br-none bg-brand-600 text-white"
                        : "rounded-bl-none border border-border bg-surface-2 text-ink"
                    }`}
                  >
                    {msg.text}
                  </div>
                  {msg.answeredVia && (
                    <span className="mt-1 text-[10px] italic text-ink-mute">
                      {msg.answeredVia === "vector_search" ? "answered via project vector search" : "answered via project memory fallback"}
                    </span>
                  )}
                  {msg.citations && msg.citations.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="mr-1 self-center text-[10px] font-semibold text-ink-faint">
                        Sources:
                      </span>
                      {msg.citations.map((cite, i) => (
                        <span
                          key={i}
                          title={cite.snippet}
                          className="cursor-pointer rounded border border-border bg-surface-2 px-2 py-0.5 text-[10px] text-ink-mute transition-colors hover:border-brand-300"
                        >
                          Meeting {cite.meetingDate}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {chatLoading && (
                <div className="flex items-center gap-1 py-2 text-xs text-ink-mute">
                  <span className="animate-bounce">●</span>
                  <span className="animate-bounce delay-75">●</span>
                  <span className="animate-bounce delay-150">●</span>
                  Thinking…
                </div>
              )}
            </div>

            <form onSubmit={handleAskQuestion} className="flex gap-2">
              <input
                type="text"
                required
                placeholder="Ask about meetings…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                className="w-full rounded-xl border border-border-strong bg-surface px-4 py-2.5 text-sm text-ink placeholder:text-ink-faint transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
              <button
                type="submit"
                disabled={chatLoading}
                className="flex items-center justify-center rounded-lg bg-brand-600 p-2.5 text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </Card>
        </section>
      </div>

      {/* Transcript modal */}
      <Modal open={!!activeTranscript} onClose={() => setActiveTranscript(null)} labelledBy="transcript-title" className="max-w-3xl">
        <div className="flex items-center justify-between border-b border-border p-6">
          <h2 id="transcript-title" className="text-lg font-semibold text-ink">
            Saved transcript
          </h2>
          <button onClick={() => setActiveTranscript(null)} className="text-ink-faint transition-colors hover:text-ink" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[60vh] flex-1 space-y-3 overflow-y-auto p-6">
          {activeTranscript && activeTranscript.lines.length === 0 ? (
            <p className="text-center text-ink-mute">No dialogue parsed.</p>
          ) : (
            activeTranscript?.lines.map((line, idx) => (
              <div key={idx} className="border border-border bg-surface-2/50 p-3 rounded-lg">
                <span className="mb-1 block text-xs font-bold text-brand-600">{line.speaker}:</span>
                <p className="text-sm text-ink-soft">{line.text}</p>
              </div>
            ))
          )}
        </div>
      </Modal>

      {/* Report modal */}
      <Modal open={!!activeReport} onClose={() => setActiveReport(null)} labelledBy="report-title" className="max-w-4xl">
        <div className="flex items-center justify-between border-b border-border p-6">
          <h2 id="report-title" className="flex items-center gap-2 text-lg font-semibold text-ink">
            <Sparkles className="h-5 w-5 text-brand-600" />
            AI summary & analytics
          </h2>
          <button onClick={() => setActiveReport(null)} className="text-ink-faint transition-colors hover:text-ink" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[65vh] flex-1 space-y-6 overflow-y-auto p-6">
          {activeReport?.speakerStats && activeReport.speakerStats.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-mute">
                Speaker talk-time ratio
              </h3>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {activeReport.speakerStats.map((stat, idx) => (
                  <div key={idx} className="border border-border bg-surface-2/50 rounded-lg p-3">
                    <div className="mb-1 flex justify-between text-sm font-medium text-ink-soft">
                      <span>{stat.speaker}</span>
                      <span>{stat.percentage}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full rounded-full bg-brand-600" style={{ width: `${stat.percentage}%` }} />
                    </div>
                    <span className="mt-1 block text-[10px] text-ink-faint">{stat.talkTime}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeReport?.scheduling?.scheduling_detected && 
           activeReport.scheduling.status !== "dismissed" && 
           (activeReport.scheduling.status === "pending" || schedSuccess) && (
            <div className="rounded-xl border border-brand-200 bg-brand-50 p-5">
              {schedSuccess ? (
                <p className="flex items-center gap-2 font-semibold text-success">
                  <CheckCircle2 className="h-4 w-4" /> Successfully added to Google Calendar!
                </p>
              ) : (
                <div>
                  <h4 className="mb-1 flex items-center gap-1.5 font-bold text-brand-700">
                    <Calendar className="h-4 w-4" />
                    Detected scheduling intent
                  </h4>
                  <p className="mb-4 rounded border-l-4 border-brand-500 bg-surface p-2.5 text-xs italic text-ink-soft">
                    &ldquo;{activeReport.scheduling.scheduling.raw_mention}&rdquo;
                  </p>

                  <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                    <Input label="Meeting title" value={schedTitle} onChange={(e) => setSchedTitle(e.target.value)} />
                    <Input label="Zoom link (optional)" value={schedZoom} onChange={(e) => setSchedZoom(e.target.value)} />
                    <Input label="Date" type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
                    <Input label="Time" type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} />
                  </div>
                  <div className="mt-4 flex justify-end gap-2 border-t border-brand-200/60 pt-3">
                    <Button variant="ghost" size="sm" onClick={handleDismissSchedule}>
                      Dismiss
                    </Button>
                    <Button size="sm" onClick={handleConfirmSchedule}>
                      Confirm & add to calendar
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeReport && (
            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-mute">
                Executive notes & highlights
              </h3>
              <div className="rounded-lg border border-border bg-surface-2/50 p-6">
                {renderMarkdown(activeReport.markdown)}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-border p-6">
          <Button
            variant="secondary"
            onClick={() => {
              if (!activeReport) return;
              const blob = new Blob([activeReport.markdown], { type: "text/markdown" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${activeReport.filename.replace(".jsonl", "_report.md")}`;
              a.click();
            }}
          >
            Download Markdown
          </Button>
          <Button onClick={() => setActiveReport(null)}>Close</Button>
        </div>
      </Modal>
    </Container>
  );
}
