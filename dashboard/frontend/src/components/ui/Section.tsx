import { cn } from "@/lib/cn";

export function Section({
  children,
  className,
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("py-16 sm:py-20", className)}>
      {children}
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "center",
}: {
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  align?: "center" | "left";
}) {
  return (
    <div className={cn(align === "center" ? "text-center mx-auto" : "text-left", "max-w-2xl")}>
      {eyebrow && (
        <p className="text-sm font-semibold tracking-wide uppercase text-brand-600 mb-3">
          {eyebrow}
        </p>
      )}
      <h2 className="text-3xl sm:text-4xl font-bold font-display text-ink tracking-tight">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-4 text-lg text-ink-mute leading-relaxed">{subtitle}</p>
      )}
    </div>
  );
}
