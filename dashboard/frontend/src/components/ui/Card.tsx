import { cn } from "@/lib/cn";

export function Card({
  children,
  className,
  hover = false,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return <div className={cn("card", hover && "card-hover", className)}>{children}</div>;
}
