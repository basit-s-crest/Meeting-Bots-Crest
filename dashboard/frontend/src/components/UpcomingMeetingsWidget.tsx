"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Calendar,
  Clock,
  Video,
  RefreshCw,
  AlertCircle,
  ArrowRight,
  Sparkles
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

import { BACKEND_URL, apiFetch } from "@/context/AuthContext";

export interface ScheduledMeeting {
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

export interface CalendarStatus {
  connected: boolean;
  configured: boolean;
  autoJoinEnabled: boolean;
  leadTimeMinutes: number;
}

const PLATFORM_META: Record<string, { label: string; tone: "brand" | "success" | "warning" }> = {
  "google-meet": { label: "Google Meet", tone: "brand" },
  zoom: { label: "Zoom", tone: "success" },
  teams: { label: "Teams", tone: "warning" }
};

function formatMeetingDate(isoString: string): { dateStr: string; timeStr: string; isToday: boolean } {
  const d = new Date(isoString);
  const now = new Date();
  
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  const tomorrow = new Date();
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    d.getDate() === tomorrow.getDate() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getFullYear() === tomorrow.getFullYear();

  let dateStr = "";
  if (isToday) {
    dateStr = "Today";
  } else if (isTomorrow) {
    dateStr = "Tomorrow";
  } else {
    dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return { dateStr, timeStr, isToday };
}

interface UpcomingMeetingsWidgetProps {
  showHeader?: boolean;
}

export function UpcomingMeetingsWidget({ showHeader = true }: UpcomingMeetingsWidgetProps) {
  const [meetings, setMeetings] = useState<ScheduledMeeting[]>([]);
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [meetingsRes, statusRes] = await Promise.all([
        apiFetch(`${BACKEND_URL}/api/calendar/scheduled`),
        apiFetch(`${BACKEND_URL}/api/calendar/auth/status`)
      ]);

      if (meetingsRes.ok) {
        const data = await meetingsRes.json();
        setMeetings(data.meetings || []);
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        setStatus(data);
      }
    } catch (err) {
      console.error("Failed to load upcoming meetings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/calendar/sync`, {
        method: "POST"
      });
      if (res.ok) {
        await fetchData();
      }
    } catch (err) {
      console.error("Calendar sync error:", err);
    } finally {
      setSyncing(false);
    }
  };

  const upcomingMeetings = meetings
    .filter((m) => m.status !== "cancelled" && new Date(m.start_time).getTime() >= Date.now() - 15 * 60 * 1000)
    .slice(0, 5);

  return (
    <Card className="flex flex-col overflow-hidden p-5 border border-border/80 bg-surface shadow-card">
      {/* Optional Card Header */}
      {showHeader && (
        <div className="flex items-center justify-between pb-3.5 mb-3.5 border-b border-border/60">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600 border border-brand-100/60">
              <Calendar className="h-4 w-4" />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-ink tracking-tight">Upcoming Meetings</h3>
              <p className="text-[11px] text-ink-mute">Google Calendar</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={handleSync}
              disabled={syncing || loading}
              title="Sync calendar events"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-mute hover:bg-surface-2 hover:text-ink disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin text-brand-600" : ""}`} />
            </button>
            <Link
              href="/calendar"
              className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700 transition-colors"
            >
              <span>Calendar</span>
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      )}

      {/* Calendar Connection Status Banner */}
      {status && !status.connected && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-xs text-amber-900 flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-amber-900 block">Calendar Disconnected</span>
              <span className="text-amber-700 text-[11px]">Connect Google Calendar to list scheduled calls.</span>
            </div>
          </div>
          <a
            href={`${BACKEND_URL}/api/calendar/auth`}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 transition-colors shadow-xs w-full text-center"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Connect Google Calendar
          </a>
        </div>
      )}

      {/* Content */}
      <div className="flex-1">
        {loading ? (
          <div className="py-8 text-center text-xs text-ink-mute flex items-center justify-center gap-2">
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-brand-500" />
            <span>Syncing schedule…</span>
          </div>
        ) : upcomingMeetings.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/80 bg-surface-2/30 p-6 text-center">
            <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-ink-faint">
              <Calendar className="h-4 w-4" />
            </div>
            <p className="text-xs font-semibold text-ink">No upcoming meetings</p>
            <p className="mt-1 text-[11px] text-ink-mute">
              {status?.connected ? "No upcoming calls found on calendar." : "Connect Google Calendar to sync automatically."}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {upcomingMeetings.map((meeting) => {
              const { dateStr, timeStr, isToday } = formatMeetingDate(meeting.start_time);
              const meta = meeting.bot_type ? PLATFORM_META[meeting.bot_type] : null;

              return (
                <div
                  key={meeting.id}
                  className="group relative flex flex-col gap-1.5 rounded-xl border border-border/70 bg-surface p-3 transition-all hover:border-brand-200 hover:bg-brand-50/20 hover:shadow-2xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                            isToday
                              ? "bg-brand-100/80 text-brand-700 border border-brand-200/50"
                              : "bg-surface-2 text-ink-soft"
                          }`}
                        >
                          <Clock className="h-2.5 w-2.5" />
                          {dateStr}, {timeStr}
                        </span>
                        {meta && (
                          <Badge tone={meta.tone} className="text-[9px] px-1.5 py-0">
                            {meta.label}
                          </Badge>
                        )}
                      </div>
                      <h4 className="text-xs font-semibold text-ink truncate group-hover:text-brand-700 transition-colors">
                        {meeting.title}
                      </h4>
                    </div>

                    {meeting.meeting_url && (
                      <a
                        href={meeting.meeting_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 border border-brand-200/60 hover:bg-brand-600 hover:text-white transition-colors"
                        title="Join Call"
                      >
                        <Video className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="mt-3.5 pt-2.5 border-t border-border/50 flex items-center justify-between text-[11px] text-ink-faint">
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${status?.connected ? "bg-emerald-500 animate-pulse" : "bg-amber-400"}`} />
          {status?.connected ? "Calendar active" : "Offline"}
        </span>
        <Link href="/calendar" className="hover:text-ink-mute transition-colors">
          Settings
        </Link>
      </div>
    </Card>
  );
}
