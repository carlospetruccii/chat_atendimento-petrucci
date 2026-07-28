import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  MessageCircle,
  Clock,
  Eye,
  BarChart,
  Settings,
  BookUser,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { useCurrentUser, type CurrentUserProfile } from "@/hooks/useCurrentUser";
import { NovoAtendimentoButton } from "@/components/NovoAtendimentoButton";
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

type MenuGate = undefined | { superadminOnly: true } | { anyOf: string[] };

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
  { title: "Inbox", url: "/inbox", icon: MessageCircle, badgeKey: "inbox" },
  { title: "Pendentes", url: "/pendentes", icon: Clock, badgeKey: "pendentes" },
  { title: "Contatos", url: "/contatos", icon: BookUser },
  { title: "Supervisão", url: "/supervisao", icon: Eye, gate: { anyOf: ["view_all_departments"] } },
  { title: "Configurações", url: "/configuracoes", icon: Settings, gate: { superadminOnly: true } },
];

function canSee(item: MenuItem, user: CurrentUserProfile | null): boolean {
  if (!item.gate) return true;
  if (!user) return false;
  if ("superadminOnly" in item.gate) return user.isSuperadmin;
  if ("anyOf" in item.gate) {
    return user.isSuperadmin || item.gate.anyOf.some((f) => user.permissions.includes(f));
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
  useTheme();
  const navigate = useNavigate();

  async function handleSair() {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  }

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

  // O badge do Inbox soma as três abas (Chat + Grupos + Equipe), que é o que o
  // usuário vê ao entrar na tela. São três RPCs porque grupo e conversa interna
  // moram em tabelas separadas.
  const inboxUnreadQ = useQuery({
    queryKey: ["inbox-unread-total"],
    queryFn: async () => {
      const [individual, grupos, equipe] = await Promise.all([
        supabase.rpc("get_my_inbox_unread_total"),
        supabase.rpc("get_my_grupos_unread_total"),
        supabase.rpc("get_my_internas_unread_total"),
      ]);
      if (individual.error) throw individual.error;
      if (grupos.error) throw grupos.error;
      if (equipe.error) throw equipe.error;
      return (individual.data ?? 0) + (grupos.data ?? 0) + (equipe.data ?? 0);
    },
    enabled: !!user,
    refetchInterval: 30_000,
  });
  const inboxUnreadCount = inboxUnreadQ.data ?? 0;

  const badgeCounts: Record<string, number> = {
    pendentes: pendentesCount,
    inbox: inboxUnreadCount,
  };

  const showPlaceholders = loading && !user;
  const visible = showPlaceholders ? menuItems : menuItems.filter((item) => canSee(item, user));

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
            const badgeCount = item.badgeKey ? (badgeCounts[item.badgeKey] ?? 0) : 0;
            const showBadge = badgeCount > 0;
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
                        {badgeCount > 99 ? "99+" : badgeCount}
                      </span>
                    )}
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">{item.title}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        <div className="flex flex-col items-center gap-3">
          <NovoAtendimentoButton />

          {/* Separa navegação (acima) de ação + identidade (abaixo). */}
          <div className="h-px w-6 bg-sidebar-border" aria-hidden />

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
