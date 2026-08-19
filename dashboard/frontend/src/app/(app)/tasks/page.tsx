"use client";

import { CheckSquare, ArrowRight, FolderKanban, Sparkles } from "lucide-react";
import Link from "next/link";
import { Container } from "@/components/ui/Container";
import { UserAssignedTasksWidget } from "@/components/UserAssignedTasksWidget";
import { Button } from "@/components/ui/Button";

export default function TasksPage() {
  return (
    <Container className="py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink flex items-center gap-2.5">
            <CheckSquare className="w-7 h-7 text-brand-600" />
            My Action Items & Tasks
          </h1>
          <p className="text-sm text-ink-mute mt-1">
            Track and complete tasks assigned to you across all your meeting projects in one unified view.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link href="/projects">
            <Button variant="secondary" className="gap-2">
              <FolderKanban className="w-4 h-4" />
              View Projects
            </Button>
          </Link>
        </div>
      </div>

      {/* Global Tasks Widget (cross-project) */}
      <UserAssignedTasksWidget
        title="All Assigned Action Items"
        className="border-border shadow-xs"
      />
    </Container>
  );
}
