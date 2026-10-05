import { createFileRoute } from "@tanstack/react-router";
import { FileText, Loader2 } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { podeAcessarDocs } from "@/lib/docs-logic";
import { DocsPane } from "@/components/docs/DocsPane";

interface DocsSearch {
  /** Conversa aberta. Fica na URL para a notificação e o recarregar abrirem direto nela. */
  conversa?: string;
}

export const Route = createFileRoute("/_app/docs")({
  staticData: { title: "Docs", noPadding: true },
  validateSearch: (search: Record<string, unknown>): DocsSearch => ({
    conversa: typeof search.conversa === "string" ? search.conversa : undefined,
  }),
  component: DocsPage,
});

/**
 * Aba Docs: conversas do número FINANCEIRO (o outro sistema manda documentos,
 * os clientes respondem aqui). Admin sempre entra; colaborador só com a
 * permissão `docs_acesso`. O menu já esconde o item de quem não tem acesso;
 * esta tela repete a trava para quem chega pelo link (a RLS é a trava de verdade).
 */
function DocsPage() {
  const { user, loading } = useCurrentUser();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  if (loading || !user) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!podeAcessarDocs(user)) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <FileText className="mx-auto h-12 w-12 text-muted-foreground" strokeWidth={1.2} />
          <h1 className="mt-3 text-base font-semibold text-foreground">Sem acesso ao Docs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            As conversas do número financeiro ficam liberadas para administradores e para quem
            recebeu acesso. Peça a um administrador para liberar em Configurações.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <DocsPane
        user={{ id: user.id, isSuperadmin: user.isSuperadmin }}
        conversaId={search.conversa ?? null}
        onSelecionar={(id) =>
          void navigate({ search: { conversa: id ?? undefined }, replace: true })
        }
      />
    </div>
  );
}
