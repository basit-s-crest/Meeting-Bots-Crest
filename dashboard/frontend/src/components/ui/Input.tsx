import { cn } from "@/lib/cn";

const fieldBase =
  "w-full rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-sm text-ink placeholder:text-ink-faint transition-colors focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:bg-surface-2 disabled:text-ink-mute";

export function Input({
  label,
  className,
  id,
  ...props
}: { label?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label
          htmlFor={id}
          className="block text-xs font-semibold text-ink-soft uppercase tracking-wider"
        >
          {label}
        </label>
      )}
      <input id={id} className={cn(fieldBase, className)} {...props} />
    </div>
  );
}

export function Textarea({
  label,
  className,
  id,
  ...props
}: { label?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label
          htmlFor={id}
          className="block text-xs font-semibold text-ink-soft uppercase tracking-wider"
        >
          {label}
        </label>
      )}
      <textarea id={id} className={cn(fieldBase, "resize-none", className)} {...props} />
    </div>
  );
}

export function Select({
  label,
  className,
  id,
  children,
  ...props
}: { label?: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label
          htmlFor={id}
          className="block text-xs font-semibold text-ink-soft uppercase tracking-wider"
        >
          {label}
        </label>
      )}
      <select id={id} className={cn(fieldBase, "appearance-none", className)} {...props}>
        {children}
      </select>
    </div>
  );
}
