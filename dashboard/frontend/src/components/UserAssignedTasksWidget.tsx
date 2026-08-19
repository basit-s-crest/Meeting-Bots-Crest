"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckSquare, Square, Calendar, Clock, AlertTriangle, CheckCircle2,
  Filter, Sparkles, User, RefreshCw, ChevronRight, HelpCircle, FolderKanban
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { apiFetch, BACKEND_URL } from "@/context/AuthContext";

export interface AssignedTask {
  id: string;
  session_id: string;
  project_id: string;
  category: string;
  description: string;
  detail?: string;
  assignee?: string;
  assignee_user_id?: string;
  assignee_confidence?: number;
  assignee_confirmed?: boolean;
  deadline?: string;
  priority?: "High" | "Medium" | "Low";
  meeting_date?: string;
  completed?: boolean;
  created_at: string;
  projects?: {
    id: string;
    name: string;
  };
}

interface UserAssignedTasksWidgetProps {
  projectId?: string;
  className?: string;
  onRefreshNeeded?: () => void;
  title?: string;
}

export function UserAssignedTasksWidget({ projectId, className, title }: UserAssignedTasksWidgetProps) {
  const [tasks, setTasks] = useState<AssignedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"pending" | "completed" | "all">("pending");
  const [selectedProjectFilter, setSelectedProjectFilter] = useState<string>("all");
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const url = projectId
        ? `${BACKEND_URL}/api/users/me/tasks?projectId=${projectId}`
        : `${BACKEND_URL}/api/users/me/tasks`;
      const res = await apiFetch(url);
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch (err) {
      console.error("Failed to load user tasks:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, [projectId]);

  const toggleTaskCompletion = async (task: AssignedTask) => {
    const nextCompleted = !task.completed;
    setTogglingId(task.id);
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/meeting-events/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: nextCompleted })
      });
      if (res.ok) {
        setTasks(prev => prev.map(t => (t.id === task.id ? { ...t, completed: nextCompleted } : t)));
      }
    } catch (err) {
      console.error("Failed to toggle task:", err);
    } finally {
      setTogglingId(null);
    }
  };

  const confirmAssignment = async (taskId: string) => {
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/meeting-events/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true })
      });
      if (res.ok) {
        setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, assignee_confirmed: true } : t)));
      }
    } catch (err) {
      console.error("Failed to confirm task:", err);
    }
  };

  // Distinct projects for global filtering
  const distinctProjects = Array.from(
    new Map(
      tasks
        .filter(t => t.project_id)
        .map(t => [t.project_id, t.projects?.name || `Project ${t.project_id.slice(0, 6)}`])
    ).entries()
  );

  const filteredTasks = tasks.filter(t => {
    if (filter === "pending" && t.completed) return false;
    if (filter === "completed" && !t.completed) return false;
    if (!projectId && selectedProjectFilter !== "all" && t.project_id !== selectedProjectFilter) return false;
    return true;
  });

  const pendingCount = tasks.filter(t => !t.completed).length;

  const formatDeadline = (deadlineStr?: string) => {
    if (!deadlineStr) return null;

    const d = new Date(deadlineStr);
    if (isNaN(d.getTime())) {
      return { label: deadlineStr, tone: "neutral" as const };
    }

    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return { label: `Overdue by ${Math.abs(diffDays)}d`, tone: "danger" as const };
    } else if (diffDays === 0) {
      return { label: "Due Today", tone: "warning" as const };
    } else if (diffDays === 1) {
      return { label: "Due Tomorrow", tone: "warning" as const };
    } else {
      return { label: `Due in ${diffDays}d (${d.toLocaleDateString()})`, tone: "brand" as const };
    }
  };

  return (
    <div className={`p-6 rounded-2xl bg-surface border border-border shadow-sm ${className || ""}`}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-5 pb-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-500">
            <CheckSquare className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-ink">
                {title || (projectId ? "My Project Action Items" : "All Assigned Tasks")}
              </h3>
              {pendingCount > 0 && (
                <Badge tone="brand" className="text-xs">
                  {pendingCount} pending
                </Badge>
              )}
            </div>
            <p className="text-xs text-ink-mute">
              Action items auto-assigned to you from meeting transcripts across your projects
            </p>
          </div>
        </div>

        {/* Filter controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Project filter dropdown (only if global view) */}
          {!projectId && distinctProjects.length > 1 && (
            <select
              value={selectedProjectFilter}
              onChange={(e) => setSelectedProjectFilter(e.target.value)}
              className="px-3 py-1.5 rounded-xl border border-border bg-surface text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            >
              <option value="all">All Projects ({tasks.length})</option>
              {distinctProjects.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}

          <div className="flex items-center gap-1.5 bg-surface-2 p-1 rounded-xl border border-border text-xs">
            <button
              onClick={() => setFilter("pending")}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                filter === "pending"
                  ? "bg-surface text-ink font-semibold shadow-xs"
                  : "text-ink-mute hover:text-ink"
              }`}
            >
              Pending ({tasks.filter(t => !t.completed).length})
            </button>
            <button
              onClick={() => setFilter("completed")}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                filter === "completed"
                  ? "bg-surface text-ink font-semibold shadow-xs"
                  : "text-ink-mute hover:text-ink"
              }`}
            >
              Completed ({tasks.filter(t => t.completed).length})
            </button>
            <button
              onClick={() => setFilter("all")}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                filter === "all"
                  ? "bg-surface text-ink font-semibold shadow-xs"
                  : "text-ink-mute hover:text-ink"
              }`}
            >
              All
            </button>
            <button
              onClick={fetchTasks}
              title="Refresh tasks"
              className="p-1.5 rounded-lg text-ink-mute hover:text-ink hover:bg-surface transition ml-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Task List */}
      {loading && tasks.length === 0 ? (
        <div className="py-12 flex flex-col items-center justify-center text-center">
          <RefreshCw className="w-6 h-6 text-brand-500 animate-spin mb-2" />
          <p className="text-sm text-ink-mute">Loading your assigned tasks...</p>
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="py-12 flex flex-col items-center justify-center text-center px-4">
          <div className="w-12 h-12 rounded-2xl bg-surface-2 flex items-center justify-center text-ink-mute mb-3">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <p className="text-sm font-medium text-ink">
            {filter === "pending" ? "No pending action items!" : "No tasks found."}
          </p>
          <p className="text-xs text-ink-mute mt-1 max-w-sm">
            When action items are assigned to you during Google Meet or Zoom calls, they’ll show up here with their deadlines and project links.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredTasks.map((task) => {
            const deadlineInfo = formatDeadline(task.deadline);
            return (
              <div
                key={task.id}
                className={`group p-4 rounded-xl border transition-all ${
                  task.completed
                    ? "bg-surface-2/40 border-border opacity-70"
                    : "bg-surface border-border hover:border-brand-500/40 hover:shadow-xs"
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Completion checkbox button */}
                  <button
                    type="button"
                    onClick={() => toggleTaskCompletion(task)}
                    disabled={togglingId === task.id}
                    className="mt-0.5 text-ink-mute hover:text-brand-500 transition shrink-0"
                  >
                    {task.completed ? (
                      <CheckSquare className="w-5 h-5 text-success" />
                    ) : (
                      <Square className="w-5 h-5 hover:text-brand-500" />
                    )}
                  </button>

                  <div className="flex-1 min-w-0">
                    <p className={`text-sm text-ink leading-snug font-medium ${
                      task.completed ? "line-through text-ink-mute" : ""
                    }`}>
                      {task.description}
                    </p>

                    {task.detail && (
                      <p className="text-xs text-ink-mute mt-1 italic line-clamp-2">
                        "{task.detail}"
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2 mt-2.5">
                      {/* Project Link Badge */}
                      {task.projects?.name && (
                        <Link
                          href={`/projects/${task.project_id}`}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-700 bg-brand-50 border border-brand-200/60 hover:bg-brand-100 px-2 py-0.5 rounded-md transition"
                        >
                          <FolderKanban className="w-3 h-3 text-brand-600" />
                          {task.projects.name}
                        </Link>
                      )}

                      {/* Deadline badge */}
                      {deadlineInfo && (
                        <Badge tone={deadlineInfo.tone} className="text-[11px] gap-1">
                          <Clock className="w-3 h-3" />
                          {deadlineInfo.label}
                        </Badge>
                      )}

                      {/* Priority badge */}
                      {task.priority && (
                        <Badge
                          tone={
                            task.priority === "High"
                              ? "danger"
                              : task.priority === "Medium"
                              ? "warning"
                              : "neutral"
                          }
                          className="text-[11px]"
                        >
                          {task.priority} Priority
                        </Badge>
                      )}

                      {/* Meeting Date */}
                      {task.meeting_date && (
                        <span className="text-[11px] text-ink-mute flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {task.meeting_date}
                        </span>
                      )}

                      {/* Confirmation badge */}
                      {!task.assignee_confirmed && (
                        <div className="flex items-center gap-1.5 ml-auto">
                          <Badge tone="warning" className="text-[11px]">
                            Needs confirmation
                          </Badge>
                          <button
                            onClick={() => confirmAssignment(task.id)}
                            className="text-xs font-medium text-brand-600 hover:text-brand-700 underline"
                          >
                            Confirm mine
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
