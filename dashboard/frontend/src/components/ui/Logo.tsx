import { Waves } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";

export function Logo({ className, textClass }: { className?: string; textClass?: string }) {
  return (
    <Link href="/" className={cn("inline-flex items-center gap-2 group", className)}>
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm transition-transform group-hover:scale-105">
        <Waves className="h-5 w-5" />
      </span>
      <span className={cn("font-display text-lg font-extrabold tracking-tight text-ink", textClass)}>
        Crest<span className="text-brand-600">Meet</span>
      </span>
    </Link>
  );
}
