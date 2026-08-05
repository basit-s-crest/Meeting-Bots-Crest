"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DrivePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/projects");
  }, [router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6 text-center text-xs text-ink-mute">
      Redirecting to Projects workspace…
    </div>
  );
}
