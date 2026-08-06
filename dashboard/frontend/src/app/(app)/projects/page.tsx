"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import {
  FolderPlus,
  Folder,
  ArrowRight,
  X,
  Search,
  Layers,
  Sparkles,
  RefreshCw,
  CalendarDays,
  Calendar,
  Clock
} from "lucide-react";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { UpcomingMeetingsWidget } from "@/components/UpcomingMeetingsWidget";
import { GoogleDriveStatusBadge } from "@/components/GoogleDriveStatusBadge";

interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

import { BACKEND_URL, apiFetch } from "@/context/AuthContext";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    fetchProjects();
  }, []);

  function fetchProjects() {
    (async () => {
      setError("");
      try {
        const res = await apiFetch(`${BACKEND_URL}/api/projects`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || "Failed to load projects");
        }
        const data = await res.json();
        setProjects(Array.isArray(data) ? data : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load projects");
      } finally {
        setLoading(false);
      }
    })();
  }

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || creating) return;

    setCreating(true);
    try {
      const res = await apiFetch(`${BACKEND_URL}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to create project");
      }

      const createdProject = await res.json();
      if (createdProject && createdProject.id) {
        setProjects(prev => [createdProject, ...prev]);
      } else {
        fetchProjects();
      }

      setName("");
      setDescription("");
      setShowCreate(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error creating project");
    } finally {
      setCreating(false);
    }
  };

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const q = searchQuery.toLowerCase();
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q)
    );
  }, [projects, searchQuery]);

  return (
    <Container className="py-8 sm:py-10">
      {/* Top Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-border/60">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink">
            Projects
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-ink-mute">
            Select a workspace to access its transcripts, AI summaries, and chat.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <GoogleDriveStatusBadge variant="button" />
          <Button onClick={() => setShowCreate(!showCreate)} className="shrink-0 shadow-xs">
            <FolderPlus className="h-4 w-4" />
            New project
          </Button>
        </div>
      </div>

      {/* New Project Inline Card Form */}
      {showCreate && (
        <Card className="mt-6 p-6 border-brand-200 bg-surface shadow-pop animate-fade-in-up">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <Sparkles className="h-4 w-4" />
              </div>
              <h2 className="text-base font-semibold text-ink">Create new workspace project</h2>
            </div>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-lg p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <form onSubmit={handleCreateProject} className="space-y-4">
            <Input
              id="proj-name"
              label="Project name"
              required
              placeholder="e.g. Acme Marketing Strategy"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Textarea
              id="proj-desc"
              label="Description (optional)"
              rows={2}
              placeholder="Summary of this project's scope, goals, or client details"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex justify-end gap-2.5 pt-2">
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>{creating ? "Creating…" : "Create project"}</Button>
            </div>
          </form>
        </Card>
      )}

      {/* Modern Dashboard 2-Column Split */}
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-12 items-start">
        {/* Left Column: Projects List (7 cols lg, 8 cols xl) */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-4">
          {/* Subheader bar - exact height alignment with right column */}
          <div className="flex items-center justify-between h-9">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-ink flex items-center gap-1.5">
                <Layers className="h-4 w-4 text-brand-600" />
                <span>Workspaces</span>
              </span>
              <Badge tone="brand" className="text-[11px] px-2 py-0.5 font-semibold">
                {projects.length} {projects.length === 1 ? "Project" : "Projects"}
              </Badge>
            </div>

            {projects.length > 0 && (
              <div className="relative max-w-xs w-48 sm:w-60">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-faint pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search projects…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface pl-8 pr-3 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 transition-all"
                />
              </div>
            )}
          </div>

          {/* Projects List Content */}
          {loading ? (
            <div className="rounded-2xl border border-border/60 bg-surface p-12 text-center text-xs text-ink-mute flex items-center justify-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin text-brand-600" />
              <span>Loading projects…</span>
            </div>
          ) : error ? (
            <Card className="border-danger/30 bg-danger-soft/40 p-6 text-center">
              <p className="font-semibold text-danger text-sm">{error}</p>
              <p className="mt-1 text-xs text-ink-mute">
                Make sure your backend server is running on port 3000.
              </p>
            </Card>
          ) : projects.length === 0 ? (
            <Card className="flex flex-col items-center justify-center gap-3 p-12 text-center border-dashed">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                <Folder className="h-6 w-6" />
              </span>
              <div>
                <p className="text-base font-semibold text-ink">No projects yet</p>
                <p className="max-w-xs text-xs text-ink-mute mt-1">
                  Create your first workspace to start capturing and summarizing meetings.
                </p>
              </div>
              <Button className="mt-2 text-xs" onClick={() => setShowCreate(true)}>
                <FolderPlus className="h-3.5 w-3.5" />
                New project
              </Button>
            </Card>
          ) : filteredProjects.length === 0 ? (
            <Card className="p-8 text-center text-xs text-ink-mute">
              No projects found matching &ldquo;{searchQuery}&rdquo;.
            </Card>
          ) : (
            <div className={filteredProjects.length === 1 ? "space-y-4" : "grid grid-cols-1 gap-4 sm:grid-cols-2"}>
              {filteredProjects.map((project) => (
                <Link key={project.id} href={`/projects/${project.id}`}>
                  <Card hover className="group flex h-full flex-col justify-between p-5 border border-border/80 transition-all hover:border-brand-200">
                    <div>
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 border border-brand-100/60 shadow-2xs group-hover:scale-105 transition-transform">
                            <Folder className="h-4.5 w-4.5" />
                          </span>
                          <div>
                            <h3 className="text-base font-semibold text-ink transition-colors group-hover:text-brand-700">
                              {project.name}
                            </h3>
                          </div>
                        </div>
                        <Badge tone="brand" className="text-[10px] font-semibold px-2 py-0.5">
                          Workspace
                        </Badge>
                      </div>

                      <p className="mt-2 line-clamp-2 text-xs text-ink-mute min-h-[2rem]">
                        {project.description || "No description provided."}
                      </p>
                    </div>

                    <div className="mt-5 pt-3 border-t border-border/50 flex items-center justify-between text-xs font-semibold text-brand-600 group-hover:text-brand-700">
                      <span>Open project</span>
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Right Column: Upcoming Meetings Schedule (5 cols lg, 4 cols xl) */}
        <div className="lg:col-span-5 xl:col-span-4 space-y-4">
          {/* Subheader bar - exact height alignment with left column */}
          <div className="flex items-center justify-between h-9">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-ink flex items-center gap-1.5">
                <Calendar className="h-4 w-4 text-brand-600" />
                <span>Upcoming Meetings</span>
              </span>
            </div>
            <Link
              href="/calendar"
              className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700 transition-colors"
            >
              <span>View calendar</span>
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>

          {/* Widget Card */}
          <UpcomingMeetingsWidget showHeader={false} />
        </div>
      </div>
    </Container>
  );
}
