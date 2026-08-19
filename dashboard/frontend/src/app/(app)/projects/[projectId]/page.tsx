"use client";

import { use, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";

import {
  ArrowLeft, FileText, Calendar, MessageSquare, Play, Send, Sparkles, Download, Eye, Clock, CheckCircle2, AlertCircle, X,
  MoreVertical, Edit2, Archive, ArchiveRestore, Trash2, Check, AlertTriangle
} from "lucide-react";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { GoogleDriveStatusBadge } from "@/components/GoogleDriveStatusBadge";
import { ParticipantIdentityModal } from "@/components/ParticipantIdentityModal";

interface TranscriptLine {
  speaker: string;
  text: string;
  timestamp?: string;
}

interface Session {
  fileName: string;
  sessionId: string;
  title?: string;
  botName?: string;
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

import { BACKEND_URL, apiFetch } from "@/context/AuthContext";

export default function ProjectWorkspacePage({ params }: { params?: Promise<{ projectId: string }> | { projectId: string } }) {
  const routeParams = useParams();
  const resolvedParams = params && typeof (params as any).then === 'function' ? use(params as Promise<{ projectId: string }>) : (params as { projectId: string });
  const projectId = resolvedParams?.projectId || (typeof routeParams?.projectId === "string" ? routeParams.projectId : Array.isArray(routeParams?.projectId) ? routeParams.projectId[0] : "");
  const router = useRouter();

  const [project, setProject] = useState<ProjectListItem | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hasAutoRedirected, setHasAutoRedirected] = useState(false);


  const [activeTab, setActiveTab] = useState<"active" | "archived">("active");
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);

  // Rename modal state
  const [renameSession, setRenameSession] = useState<Session | null>(null);
  const [renameTitleInput, setRenameTitleInput] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);

  // Delete modal state
  const [deleteSession, setDeleteSession] = useState<Session | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

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
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  const [schedTitle, setSchedTitle] = useState("");
  const [schedDate, setSchedDate] = useState("");
  const [schedTime, setSchedTime] = useState("");
  const [schedZoom, setSchedZoom] = useState("");
  const [schedSuccess, setSchedSuccess] = useState(false);

  const fetchSessions = async () => {
    try {
      const [transcriptsRes, activeSessionsRes] = await Promise.all([
        apiFetch(`${BACKEND_URL}/api/transcripts?projectId=${projectId}`),
        apiFetch(`${BACKEND_URL}/api/sessions`)
      ]);

      let transcriptList: Session[] = [];
      if (transcriptsRes.ok) {
        const data = await transcriptsRes.json();
        transcriptList = data.transcripts || [];
      }

      if (activeSessionsRes.ok) {
        const activeData = await activeSessionsRes.json();
        const activeList = activeData.sessions || [];

        for (const act of activeList) {
          // Only merge active sessions explicitly assigned to this project
          if (act.projectId !== projectId) continue;
          const exists = transcriptList.some(s => s.sessionId === act.sessionId);
          if (!exists) {
            transcriptList.unshift({
              fileName: `${act.type}_${act.sessionId}.jsonl`,
              sessionId: act.sessionId,
              title: `Live ${act.type} Meeting`,
              botName: 'Meeting Assistant Bot',
              created: new Date().toISOString(),
              size: 0,
              isDbBacked: false,
              botType: act.type,
              status: act.status || 'capturing'
            });
          }
        }
      }

      setSessions(transcriptList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error connecting to backend");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    function fetchProjectDetails() {
      (async () => {
        try {
          const res = await apiFetch(`${BACKEND_URL}/api/projects`);
          if (res.ok) {
            const list: ProjectListItem[] = await res.json();
            setAllProjects(list);
            const found = list.find((p) => p.id === projectId);
            if (found) setProject(found);
          }

        } catch {
        }
      })();
    }
    fetchProjectDetails();
    fetchSessions();
  }, [projectId]);

  const [allProjects, setAllProjects] = useState<ProjectListItem[]>([]);

  // Rename action handler
  const handleOpenRenameModal = (session: Session) => {
    setRenameSession(session);
    setRenameTitleInput(session.title || session.botName || `Meeting ${session.sessionId.substring(0, 8)}`);
    setOpenMenuSessionId(null);
  };

  const handleSaveRename = async () => {
    if (!renameSession || !renameTitleInput.trim()) return;
    setRenameLoading(true);
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/meetings/${renameSession.sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: renameTitleInput.trim() }),
      });
      if (!res.ok) throw new Error("Failed to rename meeting");
      setSessions(prev =>
        prev.map(s => (s.sessionId === renameSession.sessionId ? { ...s, title: renameTitleInput.trim() } : s))
      );
      setRenameSession(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error renaming meeting");
    } finally {
      setRenameLoading(false);
    }
  };

  // Archive / Unarchive action handler
  const handleToggleArchive = async (session: Session) => {
    const isArchived = session.status === "archived";
    const newStatus = isArchived ? "completed" : "archived";
    setOpenMenuSessionId(null);
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/meetings/${session.sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error(`Failed to ${isArchived ? "unarchive" : "archive"} meeting`);
      setSessions(prev =>
        prev.map(s => (s.sessionId === session.sessionId ? { ...s, status: newStatus } : s))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error updating archive status");
    }
  };

  // Delete action handler
  const handleDeleteMeeting = async () => {
    if (!deleteSession) return;
    setDeleteLoading(true);
    try {
      // Try primary DELETE /api/meetings/:sessionId
      let res = await apiFetch(`${BACKEND_URL}/api/meetings/${deleteSession.sessionId}`, {
        method: "DELETE",
      });

      // Fallback: try DELETE /api/transcripts/:fileName if primary route returned 404
      if (res.status === 404 && deleteSession.fileName) {
        res = await apiFetch(`${BACKEND_URL}/api/transcripts/${deleteSession.fileName}`, {
          method: "DELETE",
        });
      }

      if (!res.ok) {
        if (res.status === 404) {
          setSessions(prev => prev.filter(s => s.sessionId !== deleteSession.sessionId));
          setDeleteSession(null);
          return;
        }
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || errData.detail || "Failed to delete meeting");
      }

      setSessions(prev => prev.filter(s => s.sessionId !== deleteSession.sessionId));
      setDeleteSession(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error deleting meeting";
      if (!msg.includes("Authentication required") && !msg.includes("log in") && !msg.includes("token")) {
        alert(msg);
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleAskQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || chatLoading) return;

    const userMsg = question.trim();
    setChatMessages(prev => [...prev, { sender: "user", text: userMsg }]);
    setQuestion("");
    setChatLoading(true);

    try {
      const res = await apiFetch(`${BACKEND_URL}/api/memory/query`, {
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
      const res = await apiFetch(`${BACKEND_URL}/api/transcripts/${session.fileName}`);
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
      const res = await apiFetch(`${BACKEND_URL}/api/transcripts/${session.fileName}/generate-report`, {
        method: "POST"
      });
      if (!res.ok) throw new Error("Could not retrieve AI report");
      const data = await res.json();

      const transRes = await apiFetch(`${BACKEND_URL}/api/transcripts/${session.fileName}`);
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
          percentage: totalLines ? Math.round((totals[sp] / totalLines) * 100) : 0,
          talkTime: `${totals[sp]} turns`
        }));
      }

      const schedulingData = data.scheduling || null;
      if (schedulingData?.scheduling) {
        setSchedTitle(schedulingData.scheduling.title || "Follow-up Meeting");
        setSchedDate(schedulingData.scheduling.date || new Date().toISOString().split('T')[0]);
        setSchedTime(schedulingData.scheduling.time || "10:00");
        setSchedZoom(schedulingData.scheduling.zoom_link || "");
      }

      setActiveReport({
        sessionId: session.sessionId,
        markdown: data.report || "",
        speakerStats,
        scheduling: schedulingData,
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
      const res = await apiFetch(`${BACKEND_URL}/api/calendar/confirm-report-schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: schedTitle,
          date: schedDate,
          time: schedTime,
          zoomLink: schedZoom,
          filename: activeReport.filename
        })
      });
      if (!res.ok) throw new Error("Failed to add to Google Calendar");
      setSchedSuccess(true);
      setActiveReport(prev => {
        if (!prev) return null;
        return {
          ...prev,
          scheduling: prev.scheduling ? {
            ...prev.scheduling,
            status: "scheduled"
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
      const res = await apiFetch(`${BACKEND_URL}/api/calendar/dismiss-report-schedule`, {
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

  const activeSessions = sessions.filter(s => s.status !== "archived");
  const archivedSessions = sessions.filter(s => s.status === "archived");
  const displayedSessions = activeTab === "active" ? activeSessions : archivedSessions;

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
        <div className="flex items-center gap-2.5">
          <GoogleDriveStatusBadge variant="button" />
          <Link href={`/projects/${projectId}/meeting`}>
            <Button>
              <Play className="h-4 w-4" />
              Launch bot session
            </Button>
          </Link>
        </div>
      </div>

      {/* Live Active Session Banner */}
      {(() => {
        const activeLiveSession = sessions.find(s => !s.isDbBacked && (s.status === "capturing" || s.status === "joining" || s.status === "starting" || s.status === "in_progress"));
        if (!activeLiveSession) return null;
        return (
          <div className="mt-6 flex flex-col items-center justify-between gap-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 sm:flex-row shadow-sm">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3.5 w-3.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-emerald-500" />
              </span>
              <div>
                <h4 className="text-sm font-bold text-ink flex items-center gap-2">
                  Live Bot Capturing: {activeLiveSession.title || activeLiveSession.botName || "Meeting Bot"}
                  <Badge tone="success">{activeLiveSession.botType}</Badge>
                </h4>
                <p className="text-xs text-ink-soft mt-0.5">
                  Auto-joined meeting. Capturing live audio, transcript, and AI Q&A assistant.
                </p>
              </div>
            </div>
            <Link href={`/projects/${projectId}/meeting`}>
              <Button size="sm" className="whitespace-nowrap bg-emerald-600 hover:bg-emerald-700 text-white">
                <Eye className="h-4 w-4" />
                Open Live Transcript & Q&A
              </Button>
            </Link>
          </div>
        );
      })()}

      {/* Grid */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Sessions Section */}
        <section className="lg:col-span-2">
          <Card className="flex h-full flex-col p-6">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
                <FileText className="h-5 w-5 text-brand-600" />
                Session history
              </h2>

              {/* Tabs for Active vs Archived */}
              <div className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setActiveTab("active")}
                  className={`rounded-md px-3 py-1.5 transition-colors ${
                    activeTab === "active" ? "bg-surface text-ink font-semibold shadow-sm" : "text-ink-soft hover:text-ink"
                  }`}
                >
                  Active ({activeSessions.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("archived")}
                  className={`rounded-md px-3 py-1.5 transition-colors ${
                    activeTab === "archived" ? "bg-surface text-ink font-semibold shadow-sm" : "text-ink-soft hover:text-ink"
                  }`}
                >
                  Archived ({archivedSessions.length})
                </button>
              </div>
            </div>

            {loading ? (
              <div className="py-16 text-center text-ink-mute">Loading sessions…</div>
            ) : error ? (
              <div className="py-16 text-center font-medium text-danger">{error}</div>
            ) : displayedSessions.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-ink-faint">
                  <Clock className="h-6 w-6" />
                </span>
                <p className="text-ink-soft">
                  {activeTab === "active" ? "No active bot sessions found for this project." : "No archived meetings."}
                </p>
                <p className="text-xs text-ink-faint">
                  {activeTab === "active" ? "Launch a bot to start capturing meeting data." : "Archived meetings will appear here."}
                </p>
              </div>
            ) : (
              <div className="max-h-[70vh] flex-1 space-y-3 overflow-y-auto pr-1">
                {displayedSessions.map((session) => (
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
                        {session.title || session.botName || `Meeting: ${session.sessionId.substring(0, 8)}…`}
                      </h4>
                      <p className="mt-1 flex items-center gap-1 text-xs">
                        {session.status === "completed" ? (
                          <Badge tone="success">
                            <CheckCircle2 className="h-3 w-3" /> Completed
                          </Badge>
                        ) : session.status === "archived" ? (
                          <Badge tone="neutral">
                            <Archive className="h-3 w-3" /> Archived
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

                      {session.reportFileUrl || session.status === "completed" ? (
                        <a
                          href={`${BACKEND_URL}/api/transcripts/${session.fileName}/docx`}
                          download
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/20"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Word
                        </a>
                      ) : (
                        <span
                          title="Word document export will be available once meeting report is generated"
                          className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-faint opacity-60 cursor-not-allowed"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Word
                        </span>
                      )}

                      {/* Options Kebab Menu */}
                      <div className="relative">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setOpenMenuSessionId(openMenuSessionId === session.sessionId ? null : session.sessionId)}
                          className="px-2"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>

                        {openMenuSessionId === session.sessionId && (
                          <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-xl border border-border bg-surface shadow-xl animate-fade-in-up py-1">
                            <button
                              type="button"
                              onClick={() => handleOpenRenameModal(session)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-ink hover:bg-surface-2 text-left"
                            >
                              <Edit2 className="h-3.5 w-3.5 text-brand-600" />
                              Rename
                            </button>

                            <button
                              type="button"
                              onClick={() => handleToggleArchive(session)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-ink hover:bg-surface-2 text-left"
                            >
                              {session.status === "archived" ? (
                                <>
                                  <ArchiveRestore className="h-3.5 w-3.5 text-amber-500" />
                                  Unarchive
                                </>
                              ) : (
                                <>
                                  <Archive className="h-3.5 w-3.5 text-amber-500" />
                                  Archive
                                </>
                              )}
                            </button>

                            <div className="my-1 border-t border-border" />

                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuSessionId(null);
                                setDeleteSession(session);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-danger hover:bg-danger/10 text-left"
                            >
                              <Trash2 className="h-3.5 w-3.5 text-danger" />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section>

        {/* Chat Section */}
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
                  {msg.usedFallback && (
                    <span className="mt-1 text-[10px] text-amber-500">Using Groq direct fallback</span>
                  )}
                  {msg.citations && msg.citations.length > 0 && (
                    <div className="mt-2 space-y-1 max-w-[85%]">
                      <p className="text-[10px] font-semibold text-ink-mute uppercase tracking-wider">Citations:</p>
                      {msg.citations.map((c, cIdx) => (
                        <div key={cIdx} className="rounded-lg border border-border bg-surface-2/60 p-2 text-xs text-ink-soft">
                          <div className="flex items-center justify-between gap-2 font-medium text-ink">
                            <span>{c.platform} ({c.meetingDate})</span>
                            <span className="text-[10px] font-mono text-ink-faint">{c.sessionId.slice(0, 8)}</span>
                          </div>
                          <p className="mt-1 text-[11px] italic text-ink-mute line-clamp-2">&ldquo;{c.snippet}&rdquo;</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {chatLoading && (
                <div className="flex items-center gap-2 text-xs text-ink-mute">
                  <Sparkles className="h-4 w-4 animate-spin text-brand-600" />
                  Searching project memory…
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleAskQuestion} className="flex gap-2 border-t border-border pt-4">
              <Input
                placeholder="Ask about meetings…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={chatLoading}
                className="flex-1"
              />
              <Button type="submit" disabled={chatLoading || !question.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </Card>
        </section>
      </div>

      {/* Transcript Modal */}
      <Modal open={!!activeTranscript} onClose={() => setActiveTranscript(null)} className="max-w-3xl">
        <div className="flex items-center justify-between border-b border-border p-6">
          <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
            <FileText className="h-5 w-5 text-brand-600" />
            Transcript: {activeTranscript?.sessionId.substring(0, 8)}…
          </h2>
          <Button variant="ghost" size="sm" onClick={() => setActiveTranscript(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-6 space-y-3">
          {!activeTranscript?.lines || activeTranscript.lines.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-ink-faint">
                <Clock className="h-6 w-6 text-brand-600" />
              </span>
              <p className="text-sm font-semibold text-ink">No transcript speech captured for this meeting session yet.</p>
              <p className="text-xs text-ink-mute max-w-sm">
                Transcripts will automatically appear here as participants speak during live bot calls.
              </p>
            </div>
          ) : (
            activeTranscript.lines.map((line, i) => (
              <div key={i} className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2/40 p-3 text-sm">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-brand-600">{line.speaker || (line as any).speaker_label || "Speaker"}</span>
                  {line.timestamp && <span className="text-[10px] font-mono text-ink-faint">{line.timestamp}</span>}
                </div>
                <span className="text-ink">{line.text}</span>
              </div>
            ))
          )}
        </div>
      </Modal>

      {/* AI Report Modal */}
      <Modal open={!!activeReport} onClose={() => setActiveReport(null)} className="max-w-4xl">
        <div className="flex items-center justify-between border-b border-border p-6">
          <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
            <Sparkles className="h-5 w-5 text-brand-600" />
            AI Executive Report
          </h2>
          <Button variant="ghost" size="sm" onClick={() => setActiveReport(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-6 space-y-6">
          {activeReport?.speakerStats && activeReport.speakerStats.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-mute">
                Speaker Breakdown
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {activeReport.speakerStats.map((stat, i) => (
                  <div key={i} className="rounded-xl border border-border bg-surface-2/40 p-3">
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
                    &ldquo;{activeReport.scheduling.scheduling?.raw_mention}&rdquo;
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

      {/* Rename Meeting Modal */}
      <Modal open={!!renameSession} onClose={() => setRenameSession(null)} className="max-w-md">
        <div className="flex items-center justify-between border-b border-border p-6">
          <h3 className="flex items-center gap-2 text-base font-bold text-ink">
            <Edit2 className="h-4 w-4 text-brand-600" />
            Rename Meeting
          </h3>
          <Button variant="ghost" size="sm" onClick={() => setRenameSession(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-6 space-y-4">
          <Input
            label="Meeting Title"
            value={renameTitleInput}
            onChange={(e) => setRenameTitleInput(e.target.value)}
            placeholder="e.g. Sprint Planning Sync"
            autoFocus
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-4 bg-surface-2/40">
          <Button variant="ghost" size="sm" onClick={() => setRenameSession(null)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSaveRename} disabled={renameLoading || !renameTitleInput.trim()}>
            {renameLoading ? "Saving…" : "Save Title"}
          </Button>
        </div>
      </Modal>

      {/* Delete Meeting Confirmation Modal */}
      <Modal open={!!deleteSession} onClose={() => setDeleteSession(null)} className="max-w-md">
        <div className="flex items-center justify-between border-b border-border p-6">
          <h3 className="flex items-center gap-2 text-base font-bold text-danger">
            <AlertTriangle className="h-5 w-5 text-danger" />
            Delete Meeting Session?
          </h3>
          <Button variant="ghost" size="sm" onClick={() => setDeleteSession(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-6 space-y-3">
          <p className="text-sm text-ink-soft">
            Are you sure you want to delete <strong className="text-ink">{deleteSession?.title || deleteSession?.sessionId}</strong>?
          </p>
          <div className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-xs text-danger">
            <strong>Warning:</strong> This action is permanent. Deleting this meeting will cascade and remove all associated transcript segments, AI summaries, vector embeddings, and memory buffers.
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-4 bg-surface-2/40">
          <Button variant="ghost" size="sm" onClick={() => setDeleteSession(null)}>
            Cancel
          </Button>
          <Button size="sm" className="bg-danger hover:bg-danger/90 text-white" onClick={handleDeleteMeeting} disabled={deleteLoading}>
            {deleteLoading ? "Deleting…" : "Delete Permanently"}
          </Button>
        </div>
      </Modal>
    </Container>
  );
}
