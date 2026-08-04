"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Video,
  MapPin,
  Link as LinkIcon,
  XCircle,
  CheckCircle2,
  Loader2
} from "lucide-react";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

const BACKEND_URL = "http://localhost:3000";

interface ScheduledMeeting {
  id: string;
  calendar_event_id: string;
  project_id: string | null;
  session_id: string | null;
  title: string;
  description: string | null;
  meeting_url: string | null;
  bot_type: string | null;
  start_time: string;
  end_time: string | null;
  timezone: string | null;
  status: string;
  auto_join: boolean;
  html_link: string | null;
}

interface Project {
  id: string;
  name: string;
  description: string;
}

interface CalendarStatus {
  connected: boolean;
  configured: boolean;
  autoJoinEnabled: boolean;
  leadTimeMinutes: number;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const PLATFORM_META: Record<string, { label: string; tone: "brand" | "success" | "warning" }> = {
  "google-meet": { label: "Google Meet", tone: "brand" },
  zoom: { label: "Zoom", tone: "success" },
  teams: { label: "Teams", tone: "warning" }
};

export default function CalendarPage() {
  const today = new Date();
  const [viewDate, setViewDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [meetings, setMeetings] = useState<ScheduledMeeting[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [autoJoinEnabled, setAutoJoinEnabled] = useState(true);
  const [leadTimeMinutes, setLeadTimeMinutes] = useState(2);
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [meetingsRes, projectsRes, statusRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/calendar/scheduled`, { credentials: "include" }),
        fetch(`${BACKEND_URL}/api/projects`, { credentials: "include" }),
        fetch(`${BACKEND_URL}/api/calendar/auth/status`, { credentials: "include" })
      ]);

      if (meetingsRes.ok) {
        const data = await meetingsRes.json();
        setMeetings(data.meetings || []);
      }
      if (projectsRes.ok) {
        const data = await projectsRes.json();
        setProjects(data);
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        setStatus(data);
        if (data.autoJoinEnabled !== undefined) setAutoJoinEnabled(data.autoJoinEnabled);
        if (data.leadTimeMinutes !== undefined) setLeadTimeMinutes(data.leadTimeMinutes);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load calendar");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const projectName = useCallback(
    (id: string | null) => projects.find((p) => p.id === id)?.name || "Unassigned",
    [projects]
  );

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/calendar/sync`, {
        method: "POST",
        credentials: "include"
      });
      if (!res.ok) throw new Error("Sync failed");
      await fetchAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error syncing calendar");
    } finally {
      setSyncing(false);
    }
  };

  const handleAssign = async (meetingId: string, projectId: string) => {
    setAssigningId(meetingId);
    try {
      const res = await fetch(`${BACKEND_URL}/api/calendar/scheduled/${meetingId}/assign-project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ projectId })
      });
      if (!res.ok) throw new Error("Failed to assign");
      setMeetings((prev) =>
        prev.map((m) => (m.id === meetingId ? { ...m, project_id: projectId } : m))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error assigning meeting");
    } finally {
      setAssigningId(null);
    }
  };

  const handleUnassign = async (meetingId: string) => {
    setAssigningId(meetingId);
    try {
      const res = await fetch(`${BACKEND_URL}/api/calendar/scheduled/${meetingId}/unassign-project`, {
        method: "POST",
        credentials: "include"
      });
      if (!res.ok) throw new Error("Failed to unassign");
      setMeetings((prev) =>
        prev.map((m) => (m.id === meetingId ? { ...m, project_id: null } : m))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error unassigning meeting");
    } finally {
      setAssigningId(null);
    }
  };

  const handleToggleAutoJoin = async (newVal: boolean) => {
    setAutoJoinEnabled(newVal);
    try {
      await fetch(`${BACKEND_URL}/api/calendar/auto-join/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled: newVal })
      });
    } catch (err) {
      console.error("Failed to toggle auto-join:", err);
      setAutoJoinEnabled(!newVal);
    }
  };

  const handleChangeLeadTime = async (mins: number) => {
    setLeadTimeMinutes(mins);
    try {
      await fetch(`${BACKEND_URL}/api/calendar/auto-join/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ leadTimeMinutes: mins })
      });
    } catch (err) {
      console.error("Failed to update lead time:", err);
      setLeadTimeMinutes(leadTimeMinutes);
    }
  };

  const meetingsByDate = useMemo(() => {
    const map: Record<string, ScheduledMeeting[]> = {};
    for (const m of meetings) {
      if (m.status === "cancelled") continue;
      const key = toDateKey(new Date(m.start_time));
      if (!map[key]) map[key] = [];
      map[key].push(m);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    }
    return map;
  }, [meetings]);

  const { gridDays, monthLabel } = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1);
    // Monday-start grid
    const startOffset = (firstDay.getDay() + 6) % 7;
    const gridStart = new Date(year, month, 1 - startOffset);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = 42;
    const days: Date[] = [];
    for (let i = 0; i < cells; i++) {
      days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
    }
    return {
      gridDays: days,
      monthLabel: `${MONTHS[month]} ${year}`
    };
  }, [viewDate]);

  const prevMonth = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
  const nextMonth = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
  const goToday = () => setViewDate(new Date(today.getFullYear(), today.getMonth(), 1));

  const isToday = (d: Date) => toDateKey(d) === toDateKey(today);

  return (
    <Container className="py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Calendar</h1>
          <p className="mt-1 text-ink-mute">
            View Google Calendar sync status and manage auto-join meeting settings.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleSync} disabled={syncing || !status?.connected}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync
          </Button>
        </div>
      </div>

      {/* Connection + settings bar */}
      <Card className="mt-6 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
              <CalendarDays className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-ink">Google Calendar</h2>
                {status?.connected ? (
                  <Badge tone="success">Connected</Badge>
                ) : (
                  <Badge tone="danger">Not connected</Badge>
                )}
              </div>
              <p className="text-xs text-ink-mute">
                {status?.connected
                  ? "Meetings stay in sync via push notifications."
                  : "Connect to see your upcoming meetings here."}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            {status?.connected && (
              <>
                <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs font-medium text-ink-soft">
                  <input
                    type="checkbox"
                    checked={autoJoinEnabled}
                    onChange={(e) => handleToggleAutoJoin(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  Auto-join meetings
                </label>
                <label className="flex items-center gap-1.5 text-xs font-medium text-ink-soft">
                  Join
                  <select
                    value={leadTimeMinutes}
                    onChange={(e) => handleChangeLeadTime(Number(e.target.value))}
                    className="rounded-md border border-border-strong bg-surface px-1.5 py-1 text-xs text-ink"
                  >
                    {[1, 2, 5, 10, 15].map((m) => (
                      <option key={m} value={m}>{m}m</option>
                    ))}
                  </select>
                  before
                </label>
              </>
            )}
            {status?.connected ? (
              <a
                href={`${BACKEND_URL}/api/calendar/auth/disconnect`}
                onClick={(e) => {
                  if (!confirm("Disconnect Google Calendar?")) {
                    e.preventDefault();
                    return;
                  }
                }}
                className="text-xs font-semibold text-rose-500 hover:text-rose-600 hover:underline"
              >
                Disconnect
              </a>
            ) : (
              <a
                href={`${BACKEND_URL}/api/calendar/auth`}
                className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700"
              >
                Connect Calendar
              </a>
            )}
          </div>
        </div>
      </Card>

      {/* Calendar grid */}
      <Card className="mt-6 p-4 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-bold text-ink">{monthLabel}</h2>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={prevMonth} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={goToday}>
              Today
            </Button>
            <Button variant="ghost" size="sm" onClick={nextMonth} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="py-20 text-center text-ink-mute">Loading calendar…</div>
        ) : error ? (
          <div className="py-20 text-center text-danger">{error}</div>
        ) : (
          <>
            <div className="grid grid-cols-7 border-b border-border pb-2 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              {WEEKDAYS.map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-border bg-border">
              {gridDays.map((day, idx) => {
                const key = toDateKey(day);
                const dayMeetings = meetingsByDate[key] || [];
                const inMonth = day.getMonth() === viewDate.getMonth();
                return (
                  <div
                    key={idx}
                    className={cn(
                      "min-h-[88px] bg-surface p-1.5 sm:min-h-[112px] sm:p-2",
                      !inMonth && "bg-surface-2/60"
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className={cn(
                          "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                          isToday(day)
                            ? "bg-brand-600 text-white"
                            : inMonth
                              ? "text-ink"
                              : "text-ink-faint"
                        )}
                      >
                        {day.getDate()}
                      </span>
                      {dayMeetings.length > 0 && (
                        <span className="hidden rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 sm:block">
                          {dayMeetings.length}
                        </span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {dayMeetings.slice(0, 3).map((m) => {
                        const meta = PLATFORM_META[m.bot_type || ""] || { label: "Meeting", tone: "brand" as const };
                        return (
                          <div
                            key={m.id}
                            className={cn(
                              "group flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium leading-tight sm:text-[11px]",
                              m.project_id
                                ? "bg-brand-50 text-brand-800"
                                : "bg-warning-soft text-warning"
                            )}
                            title={m.title}
                          >
                            <span className="truncate">{m.title}</span>
                            <span className="ml-auto hidden shrink-0 text-ink-faint sm:inline">
                              {formatTime(m.start_time)}
                            </span>
                          </div>
                        );
                      })}
                      {dayMeetings.length > 3 && (
                        <div className="px-1.5 text-[10px] font-semibold text-ink-faint">
                          +{dayMeetings.length - 3} more
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>
    </Container>
  );
}
