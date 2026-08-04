import { Waves } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";

export function Logo({ className, textClass }: { className?: string; textClass?: string }) {
  return (
    <Link href="/" className={cn("inline-flex items-center gap-2.5 group", className)}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white shadow-xs transition-transform group-hover:scale-105">
        <Waves className="h-5 w-5" />
      </span>
      <span className={cn("font-display text-lg font-extrabold tracking-tight text-ink", textClass)}>
        Crest<span className="text-brand-600">Meet</span>
      </span>
    </Link>
  );
}
