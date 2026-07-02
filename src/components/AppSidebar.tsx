import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  MessageCircle,
  Clock,
  Eye,
  BarChart,
  Settings,
  Users,
  BookUser,
  Smartphone,
  Moon,
  Sun,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { useCurrentUser, type CurrentUserProfile } from "@/hooks/useCurrentUser";
import { useTheme } from "@/hooks/useTheme";
import { supabase } from "@/integrations/supabase/client";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type MenuGate = undefined | { superadminOnly: true } | { anyOf: string[] } | { clientesFlag: true };

type MenuItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  gate?: MenuGate;
  badgeKey?: string;
};

const menuItems: MenuItem[] = [
  {
    title: "Dashboard",
    url: "/dashboard",
    icon: BarChart,
    gate: { anyOf: ["view_all_departments"] },
  },
  { title: "Inbox", url: "/inbox", icon: MessageCircle },
  { title: "Pendentes", url: "/pendentes", icon: Clock, badgeKey: "pendentes" },
  { title: "Clientes", url: "/clientes", icon: Users, gate: { clientesFlag: true } },
  { title: "Agenda", url: "/agenda", icon: BookUser },
  { title: "Supervisão", url: "/supervisao", icon: Eye, gate: { anyOf: ["view_all_departments"] } },
  {
    title: "Conexão do WhatsApp",
    url: "/conexao",
    icon: Smartphone,
    gate: { superadminOnly: true },
  },
  { title: "Configurações", url: "/configuracoes", icon: Settings, gate: { superadminOnly: true } },
];

function canSee(
  item: MenuItem,
  user: CurrentUserProfile | null,
  clientesVisivel: boolean,
): boolean {
  if (!item.gate) return true;
  if (!user) return false;
  if ("superadminOnly" in item.gate) return user.isSuperadmin;
  if ("anyOf" in item.gate) {
    return user.isSuperadmin || item.gate.anyOf.some((f) => user.permissions.includes(f));
  }
  if ("clientesFlag" in item.gate) {
    return (
      user.isSuperadmin || user.permissions.includes("view_all_departments") || clientesVisivel
    );
  }
  return false;
}

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function AppSidebar() {
  const { user, loading } = useCurrentUser();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  async function handleSair() {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  }

  const clientesFlagQ = useQuery({
    queryKey: ["system_config", "clientes_visivel_para_todos"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_config")
        .select("valor")
        .eq("chave", "clientes_visivel_para_todos")
        .maybeSingle();
      if (error) throw error;
      return data?.valor === "true";
    },
    initialData: true,
    staleTime: 30_000,
  });
  const clientesVisivel = clientesFlagQ.data !== false;

  const pendentesCountQ = useQuery({
    queryKey: ["pendentes-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("atendimentos")
        .select("*", { head: true, count: "exact" })
        .in("status", ["pendente", "em_triagem"])
        .is("assigned_to", null);
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 30_000,
  });
  const pendentesCount = pendentesCountQ.data ?? 0;

  const showPlaceholders = loading && !user;
  const visible = showPlaceholders
    ? menuItems
    : menuItems.filter((item) => canSee(item, user, clientesVisivel));

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        className="flex h-full w-[70px] shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-sidebar py-3"
        aria-label="Navegação principal"
      >
        <nav className="flex flex-col items-center gap-1">
          {visible.map((item) => {
            const active = pathname.startsWith(item.url);
            const Icon = item.icon;
            const showBadge = item.badgeKey === "pendentes" && pendentesCount > 0;
            return (
              <Tooltip key={item.url}>
                <TooltipTrigger asChild>
                  <Link
                    to={item.url}
                    className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
                      active
                        ? "bg-[color-mix(in_oklab,var(--wa-green)_18%,transparent)] text-primary"
                        : "text-sidebar-foreground/70 hover:bg-[color-mix(in_oklab,var(--wa-green)_10%,transparent)] hover:text-primary"
                    }`}
                    aria-label={item.title}
                  >
                    <Icon className="h-5 w-5" strokeWidth={1.75} />
                    {showBadge && (
                      <span className="badge-counter absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none">
                        {pendentesCount > 99 ? "99+" : pendentesCount}
                      </span>
                    )}
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">{item.title}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        <div className="flex flex-col items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleTheme}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                aria-label={theme === "dark" ? "Mudar para tema claro" : "Mudar para tema escuro"}
              >
                {theme === "dark" ? (
                  <Sun className="h-5 w-5" strokeWidth={1.75} />
                ) : (
                  <Moon className="h-5 w-5" strokeWidth={1.75} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {theme === "dark" ? "Tema claro" : "Tema escuro"}
            </TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                    aria-label={user?.nome ?? "Usuário"}
                  >
                    {loading || !user ? "··" : initials(user.nome)}
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">
                {loading || !user ? "Carregando..." : user.nome}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="right" align="end" className="w-56">
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{user?.nome ?? "—"}</span>
                {user?.email && (
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {user.email}
                  </span>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSair}>
                <LogOut className="mr-2 h-4 w-4" />
                Sair
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </TooltipProvider>
  );
}
