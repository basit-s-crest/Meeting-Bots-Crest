import { cn } from "@/lib/cn";

type Tone = "brand" | "success" | "warning" | "danger" | "neutral";

const tones: Record<Tone, string> = {
  brand: "bg-brand-50 text-brand-700 border-brand-200",
  success: "bg-success-soft text-success border-success/20",
  warning: "bg-warning-soft text-warning border-warning/20",
  danger: "bg-danger-soft text-danger border-danger/20",
  neutral: "bg-surface-2 text-ink-mute border-border",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
