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
import { MobileNav } from "@/components/MobileNav";
import { NotificationsManager } from "@/components/NotificationsManager";
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
      <div className="flex h-dvh w-full items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    // h-dvh, não h-screen: no Safari do iPhone `100vh` é a altura COM a barra de
    // endereço recolhida, então o rodapé de qualquer tela cheia (o compositor do
    // chat, principalmente) ficava escondido atrás dela. `dvh` acompanha a
    // barra aparecendo e sumindo.
    //
    // O padding-bottom reserva a faixa da barra de navegação do celular. Fica no
    // contêiner (box-sizing: border-box) e não no <main>: assim a altura de
    // `h-full` das telas já desconta a barra, e o `p-8`/`noPadding` de dentro
    // continua sendo só decisão de respiro da tela.
    <div className="flex h-dvh w-full bg-background pb-[var(--mobile-nav-total)] md:pb-0">
      <NotificationsManager />
      <AppSidebar />
      <main
        key={pathname}
        // min-w-0: sem isso um filho flex com conteúdo largo (tabela, nome de
        // arquivo, URL numa bolha) empurra o layout em vez de encolher, e a
        // página inteira ganha rolagem horizontal no celular.
        className={`min-w-0 flex-1 overflow-auto bg-background animate-in fade-in duration-150 ${
          noPadding ? "" : "p-4 sm:p-6 md:p-8"
        }`}
      >
        <Outlet />
      </main>
      <MobileNav />
    </div>
  );
}
