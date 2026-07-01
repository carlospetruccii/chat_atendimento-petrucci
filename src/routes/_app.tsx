import {
  createFileRoute,
  Outlet,
  useMatches,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { AppSidebar } from "@/components/AppSidebar";
import { useAuthSession } from "@/hooks/useAuthSession";

export interface AppRouteStaticData {
  title?: string;
  noPadding?: boolean;
}

export const Route = createFileRoute("/_app")({
  component: AppLayoutRoute,
});

function AppLayoutRoute() {
  const matches = useMatches();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { session, loading } = useAuthSession();

  // Porteiro (client-side — a sessão vive no localStorage, indisponível no SSR):
  //  - sem sessão            → login
  //  - senha temporária ativa → troca de senha obrigatória
  useEffect(() => {
    if (loading) return;
    if (!session) {
      navigate({ to: "/login" });
      return;
    }
    if (session.user?.user_metadata?.must_change_password === true) {
      navigate({ to: "/trocar-senha" });
    }
  }, [session, loading, navigate]);

  const staticData = (matches[matches.length - 1]?.staticData ?? {}) as AppRouteStaticData;
  const noPadding = !!staticData.noPadding;

  // Enquanto a sessão não é conhecida (ou vamos redirecionar), não renderiza a app —
  // evita "piscar" telas internas e chamadas sem identidade.
  const bloqueado =
    loading || !session || session.user?.user_metadata?.must_change_password === true;
  if (bloqueado) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-background">
      <AppSidebar />
      <main
        key={pathname}
        className={`flex-1 overflow-auto bg-background animate-in fade-in duration-150 ${
          noPadding ? "" : "p-8"
        }`}
      >
        <Outlet />
      </main>
    </div>
  );
}
