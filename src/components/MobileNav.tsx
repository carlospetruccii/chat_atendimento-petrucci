import { useRef, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { LogOut, MessageSquarePlus, MoreHorizontal, UserPlus } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNavBadges } from "@/hooks/useNavBadges";
import { splitMobileNav, visibleItems, type MenuItem } from "@/lib/nav-items";
import { supabase } from "@/integrations/supabase/client";
import { IniciarAtendimentoDialog } from "@/components/inbox/IniciarAtendimentoDialog";
import { AdicionarContatoDialog } from "@/components/AdicionarContatoDialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Navegação principal do celular: barra fixa no rodapé.
 *
 * Por que barra inferior e não menu hambúrguer: este é um app de atendimento
 * usado o dia inteiro, alternando entre Inbox e Pendentes dezenas de vezes. O
 * hambúrguer cobra dois toques por troca e esconde os badges de não-lidas —
 * justamente o sinal que faz o colaborador trocar de tela. A barra fica no
 * alcance do polegar e mostra os contadores sem abrir nada.
 *
 * Só cabem 4 destinos com alvo de toque decente. O 5º slot é sempre a
 * identidade (avatar), que abre uma folha com o que sobrou da navegação,
 * "Iniciar atendimento" e "Sair" — porque no desktop essas três coisas moram no
 * pé da régua lateral e precisam de casa no celular também.
 *
 * A barra é irmã da régua lateral, não substituta: as duas ficam montadas e o
 * CSS decide qual aparece (`md:hidden` aqui, `hidden md:flex` na régua). Decidir
 * isso em JavaScript faria o celular pintar o layout de desktop e pular na
 * hidratação.
 */
export function MobileNav() {
  const { user, loading } = useCurrentUser();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const badges = useNavBadges();
  const [menuAberto, setMenuAberto] = useState(false);
  const [novoAtendimento, setNovoAtendimento] = useState(false);
  const [novoContato, setNovoContato] = useState(false);
  const maisButtonRef = useRef<HTMLButtonElement>(null);

  const itens = visibleItems(user);
  const { bar, overflow } = splitMobileNav(itens);

  // Mesma regra do Inbox: só quem enxerga todos os departamentos escolhe
  // departamento/atendente na hora de abrir o atendimento.
  const canViewAll =
    !!user && (user.isSuperadmin || user.permissions.includes("view_all_departments"));

  const badgeDe = (item: MenuItem) => (item.badgeKey ? badges[item.badgeKey] : 0);

  async function handleSair() {
    setMenuAberto(false);
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  }

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex h-[calc(var(--mobile-nav-h)+var(--safe-bottom))] items-stretch border-t border-sidebar-border bg-sidebar pb-safe md:hidden"
        aria-label="Navegação principal"
      >
        {bar.map((item) => {
          const ativo = pathname.startsWith(item.url);
          const Icon = item.icon;
          const contador = badgeDe(item);
          return (
            <Link
              key={item.url}
              to={item.url}
              aria-label={item.title}
              aria-current={ativo ? "page" : undefined}
              className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors ${
                ativo ? "text-primary" : "text-sidebar-foreground/70"
              }`}
            >
              {/* Traço superior em vez de pílula preenchida: a barra inteira é
                  uma superfície só e um bloco colorido a quebraria em cinco. */}
              <span
                className={`absolute inset-x-3 top-0 h-0.5 rounded-full transition-opacity ${
                  ativo ? "bg-primary opacity-100" : "opacity-0"
                }`}
                aria-hidden
              />
              <span className="relative">
                <Icon className="h-[22px] w-[22px]" strokeWidth={ativo ? 2.1 : 1.75} />
                {contador > 0 && (
                  <span className="badge-counter absolute -right-2 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none">
                    {contador > 99 ? "99+" : contador}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium leading-none">
                {item.shortTitle ?? item.title}
              </span>
            </Link>
          );
        })}

        <button
          ref={maisButtonRef}
          type="button"
          onClick={() => setMenuAberto(true)}
          aria-label="Mais opções"
          aria-haspopup="dialog"
          className="flex flex-1 flex-col items-center justify-center gap-0.5 text-sidebar-foreground/70 transition-colors"
        >
          {loading || !user ? (
            <MoreHorizontal className="h-[22px] w-[22px]" strokeWidth={1.75} />
          ) : (
            <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
              {initials(user.nome)}
            </span>
          )}
          <span className="text-[10px] font-medium leading-none">Mais</span>
        </button>
      </nav>

      <Sheet open={menuAberto} onOpenChange={setMenuAberto}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-safe">
          <SheetHeader>
            <SheetTitle className="text-left">{user?.nome ?? "—"}</SheetTitle>
            {user?.email && <SheetDescription className="text-left">{user.email}</SheetDescription>}
          </SheetHeader>

          <div className="mt-4 flex flex-col gap-1">
            <button
              type="button"
              onClick={() => {
                setMenuAberto(false);
                setNovoAtendimento(true);
              }}
              className="flex min-h-[52px] items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-primary-foreground"
              style={{
                backgroundImage:
                  "linear-gradient(140deg, var(--wa-green) 0%, var(--wa-green-hover) 100%)",
              }}
            >
              <MessageSquarePlus className="h-5 w-5 shrink-0" strokeWidth={1.9} />
              Iniciar atendimento
            </button>

            {!!user && (
              <button
                type="button"
                onClick={() => {
                  setMenuAberto(false);
                  setNovoContato(true);
                }}
                className="flex min-h-[52px] items-center gap-3 rounded-xl border border-border px-3 text-left text-sm font-medium text-foreground active:bg-muted"
              >
                <UserPlus
                  className="h-5 w-5 shrink-0 text-muted-foreground"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                Adicionar contato
              </button>
            )}

            {overflow.map((item) => {
              const Icon = item.icon;
              const contador = badgeDe(item);
              return (
                <Link
                  key={item.url}
                  to={item.url}
                  onClick={() => setMenuAberto(false)}
                  className="flex min-h-[52px] items-center gap-3 rounded-xl px-3 text-sm font-medium text-foreground active:bg-muted"
                >
                  <Icon className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  {item.title}
                  {contador > 0 && (
                    <span className="badge-counter ml-auto flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none">
                      {contador > 99 ? "99+" : contador}
                    </span>
                  )}
                </Link>
              );
            })}

            <div className="my-1 h-px bg-border" aria-hidden />

            <button
              type="button"
              onClick={handleSair}
              className="flex min-h-[52px] items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-foreground active:bg-muted"
            >
              <LogOut className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              Sair
            </button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Fora da folha de propósito: dois diálogos empilhados brigam pelo foco. */}
      <IniciarAtendimentoDialog
        open={novoAtendimento}
        onOpenChange={setNovoAtendimento}
        canChooseDept={canViewAll}
        onCreated={(atendimentoId) => {
          setNovoAtendimento(false);
          void navigate({ to: "/inbox", search: { conversation: atendimentoId } });
        }}
      />

      <AdicionarContatoDialog
        open={novoContato}
        onOpenChange={setNovoContato}
        returnFocusRef={maisButtonRef}
      />
    </>
  );
}
