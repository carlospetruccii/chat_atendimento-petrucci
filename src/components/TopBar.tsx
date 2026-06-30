import { Bell } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function TopBar({ title }: { title: string }) {
  const { user, loading } = useCurrentUser();
  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-card px-8">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <div className="flex items-center gap-4">
        <button className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
          <Bell className="h-5 w-5" strokeWidth={1.5} />
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary" />
        </button>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-medium text-primary">
          {loading || !user ? "··" : initials(user.nome)}
        </div>
      </div>
    </header>
  );
}
