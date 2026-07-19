"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderPlus, Folder, ArrowRight, X } from "lucide-react";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";

interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

const BACKEND_URL = "http://localhost:3000";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchProjects();
  }, []);

  function fetchProjects() {
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/projects`);
        if (!res.ok) throw new Error("Failed to load projects");
        const data = await res.json();
        setProjects(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load projects");
      } finally {
        setLoading(false);
      }
    })();
  }

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      const res = await fetch(`${BACKEND_URL}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      if (!res.ok) throw new Error("Failed to create project");

      setName("");
      setDescription("");
      setShowCreate(false);
      fetchProjects();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error creating project");
    }
  };

  return (
    <Container className="py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink">
            Projects
          </h1>
          <p className="mt-1 text-ink-mute">
            Select a workspace to access its transcripts, AI summaries, and chat.
          </p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <FolderPlus className="h-4 w-4" />
          New project
        </Button>
      </div>

      {showCreate && (
        <Card className="mt-6 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">Create new project</h2>
            <button
              onClick={() => setShowCreate(false)}
              className="text-ink-faint transition-colors hover:text-ink"
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
              rows={3}
              placeholder="Summary of this project's scope, goals, or client details"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex justify-end gap-3">
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit">Create project</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="mt-8">
        {loading ? (
          <div className="py-20 text-center text-ink-mute">Loading projects…</div>
        ) : error ? (
          <Card className="border-danger/30 bg-danger-soft/40 p-8 text-center">
            <p className="font-medium text-danger">{error}</p>
            <p className="mt-1 text-sm text-ink-mute">
              Make sure your backend server is running on port 3000.
            </p>
          </Card>
        ) : projects.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-3 p-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-ink-faint">
              <Folder className="h-7 w-7" />
            </span>
            <p className="text-lg font-semibold text-ink">No projects yet</p>
            <p className="max-w-sm text-sm text-ink-mute">
              Create your first workspace to start capturing and summarizing meetings.
            </p>
            <Button className="mt-2" onClick={() => setShowCreate(true)}>
              <FolderPlus className="h-4 w-4" />
              New project
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link key={project.id} href={`/projects/${project.id}`}>
                <Card hover className="group flex h-full flex-col justify-between p-6">
                  <div>
                    <div className="mb-4 flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-100">
                        <Folder className="h-5 w-5" />
                      </span>
                      <Badge tone="brand">Workspace</Badge>
                    </div>
                    <h3 className="text-lg font-semibold text-ink transition-colors group-hover:text-brand-700">
                      {project.name}
                    </h3>
                    <p className="mt-2 line-clamp-3 text-sm text-ink-mute">
                      {project.description || "No description provided."}
                    </p>
                  </div>
                  <div className="mt-6 flex items-center gap-1.5 text-sm font-semibold text-brand-600">
                    Open project
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </Container>
  );
}
