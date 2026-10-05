import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  AlertTriangle,
  CalendarIcon,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchOperacaoConfig,
  setBotAtivacaoProgramada,
  setBotAtivo,
  setEncerramentoAutomaticoAtivo,
  setNotificarColaboradoresPendente,
  setPendentesAbertosATodos,
  setTriagemLembreteAtivo,
  setTriagemLembreteMinutos,
  setTriagemReiniciaAoVirarDia,
} from "@/lib/configuracoes-queries";
import { Input } from "@/components/ui/input";

const STOPS = [
  "Triagem automática",
  "Templates de fora-de-horário",
  "Encerramento automático por inatividade",
  "Notificação automática ao Administrador",
  "Retry automático de mensagens em falha",
];
const KEEPS = [
  "Recebimento de mensagens via webhook",
  "Envio manual pelo atendente",
  "Repasse e encerramento manual",
];

export function OperacaoTab() {
  const { user, loading } = useCurrentUser();
  const qc = useQueryClient();
  const cfgQ = useQuery({ queryKey: ["operacao-config"], queryFn: fetchOperacaoConfig });
  const [date, setDate] = useState<Date | undefined>(undefined);

  useEffect(() => {
    if (cfgQ.data?.bot_ativacao_programada) {
      setDate(new Date(cfgQ.data.bot_ativacao_programada));
    } else {
      setDate(undefined);
    }
  }, [cfgQ.data?.bot_ativacao_programada]);

  const toggleMut = useMutation({
    mutationFn: (ativo: boolean) => setBotAtivo(ativo),
    onSuccess: (_d, ativo) => {
      qc.invalidateQueries({ queryKey: ["operacao-config"] });
      toast.success(
        ativo
          ? "Bot reativado. A automação volta em até 1 minuto (cache)."
          : "Bot desligado. A automação pausa em até 1 minuto (cache).",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [confirmOpenPendentes, setConfirmOpenPendentes] = useState(false);

  const togglePendentesMut = useMutation({
    mutationFn: (ativo: boolean) => setPendentesAbertosATodos(ativo),
    onSuccess: (_d, ativo) => {
      qc.invalidateQueries({ queryKey: ["operacao-config"] });
      toast.success(
        ativo
          ? "Modo emergência ligado — todos os atendentes veem os pendentes."
          : "Modo emergência desligado — visibilidade restaurada por departamento.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveDateMut = useMutation({
    mutationFn: (d: string | null) => setBotAtivacaoProgramada(d),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["operacao-config"] });
      toast.success(v ? "Agendamento salvo" : "Agendamento cancelado");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleReiniciaTriagemMut = useMutation({
    mutationFn: (ativo: boolean) => setTriagemReiniciaAoVirarDia(ativo),
    onSuccess: (_d, ativo) => {
      qc.invalidateQueries({ queryKey: ["operacao-config"] });
      toast.success(
        ativo
          ? "Triagem reiniciará automaticamente quando o cliente voltar a falar em outro dia."
          : "Triagem não reinicia mais ao virar o dia.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleNotifColabMut = useMutation({
    mutationFn: (ativo: boolean) => setNotificarColaboradoresPendente(ativo),
    onSuccess: (_d, ativo) => {
      qc.invalidateQueries({ queryKey: ["operacao-config"] });
      toast.success(
        ativo
          ? "Aviso ligado — colaboradores serão avisados quando cair um pendente."
          : "Aviso desligado.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleLembreteMut = useMutation({
    mutationFn: (ativo: boolean) => setTriagemLembreteAtivo(ativo),
    onSuccess: (_d, ativo) => {
      qc.invalidateQueries({ queryKey: ["operacao-config"] });
      toast.success(ativo ? "Lembrete da triagem ativado." : "Lembrete da triagem desativado.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleEncerramentoMut = useMutation({
    mutationFn: (ativo: boolean) => setEncerramentoAutomaticoAtivo(ativo),
    onSuccess: (_d, ativo) => {
      qc.invalidateQueries({ queryKey: ["operacao-config"] });
      toast.success(
        ativo
          ? "Encerramento automático ligado — atendimentos parados voltam a ser encerrados sozinhos."
          : "Encerramento automático desligado — só encerramento manual a partir de agora.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [lembreteMin, setLembreteMin] = useState<string>("");
  useEffect(() => {
    if (cfgQ.data?.triagem_lembrete_minutos != null) {
      setLembreteMin(String(cfgQ.data.triagem_lembrete_minutos));
    }
  }, [cfgQ.data?.triagem_lembrete_minutos]);

  const saveLembreteMinMut = useMutation({
    mutationFn: (m: number) => setTriagemLembreteMinutos(m),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operacao-config"] });
      toast.success("Tempo do lembrete salvo.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user?.isSuperadmin) {
    return (
      <div className="rounded-2xl border border-border bg-card p-10 text-center shadow-sm">
        <ShieldAlert className="mx-auto h-10 w-10 text-muted-foreground" strokeWidth={1.5} />
        <h3 className="mt-3 text-base font-semibold text-foreground">Acesso restrito</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Apenas a administradora pode operar o kill switch do bot.
        </p>
      </div>
    );
  }

  if (cfgQ.isLoading || !cfgQ.data) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const cfg = cfgQ.data;
  const ativo = cfg.bot_ativo;

  return (
    <div className="flex flex-col gap-6">
      {/* Bloco 1 — Estado do bot */}
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">Estado do bot</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Kill switch global. Quando desligado, toda a automação para imediatamente.
            </p>
          </div>
          <Switch
            checked={ativo}
            disabled={toggleMut.isPending}
            onCheckedChange={(v) => toggleMut.mutate(v)}
            className="scale-125"
          />
        </div>

        <div
          className={cn(
            "mt-5 flex items-center gap-3 rounded-xl border p-4",
            ativo
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800",
          )}
        >
          {ativo ? (
            <CheckCircle2 className="h-5 w-5 shrink-0" strokeWidth={2} />
          ) : (
            <XCircle className="h-5 w-5 shrink-0" strokeWidth={2} />
          )}
          <div className="text-sm font-medium">
            {ativo ? "Bot ativo — triagem rodando" : "Bot desligado — automação suspensa"}
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">O que acontece ao religar</p>
          <p className="mt-1">
            Ao religar, o bot ignora as mensagens que chegaram enquanto estava desligado. Esse
            estoque continua visível na inbox para atendimento humano. Mensagens novas, recebidas
            após a religação, voltam a ser triadas normalmente.
          </p>
          {cfg.bot_ativado_em && (
            <p className="mt-2 text-xs">
              Última religação:{" "}
              <strong>
                {format(new Date(cfg.bot_ativado_em), "PPP 'às' HH:mm", { locale: ptBR })}
              </strong>
            </p>
          )}
        </div>
      </div>

      {/* Bloco 1.5 — Modo emergência: pendentes abertos a todos */}
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">Pendentes abertos a todos</h3>
              {cfg.pendentes_abertos_a_todos && (
                <Badge className="bg-amber-200 text-amber-900 hover:bg-amber-200">
                  modo emergência ativo
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-amber-800">
              Quando ligado, qualquer atendente vê todos os pendentes do sistema — inclusive de
              outros departamentos e os sem departamento. Use enquanto a triagem automática estiver
              desligada.
            </p>
          </div>
          <Switch
            checked={cfg.pendentes_abertos_a_todos}
            disabled={togglePendentesMut.isPending}
            onCheckedChange={(v) => {
              if (v) {
                setConfirmOpenPendentes(true);
              } else {
                togglePendentesMut.mutate(false);
              }
            }}
            className="scale-125"
          />
        </div>
      </div>

      {/* Bloco 1.7 — Reiniciar triagem ao virar o dia */}
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">
              Reiniciar triagem ao virar o dia
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Quando ligado, se uma triagem ficou sem resposta e o cliente voltar a mandar mensagem
              em outra data (fuso de São Paulo), o atendimento antigo é encerrado automaticamente e
              a triagem recomeça — bot dispara boas-vindas + pergunta de departamento de novo. Não
              afeta atendimentos já em andamento.
            </p>
          </div>
          <Switch
            checked={cfg.triagem_reinicia_ao_virar_dia}
            disabled={toggleReiniciaTriagemMut.isPending}
            onCheckedChange={(v) => toggleReiniciaTriagemMut.mutate(v)}
            className="scale-125"
          />
        </div>
      </div>

      {/* Bloco 1.8 — Lembrete na triagem sem resposta */}
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">
              Lembrete na triagem sem resposta
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Quando ligado, se o cliente não responder a pergunta de departamento dentro do tempo
              configurado, o bot envia um único lembrete pedindo que responda. Só dispara em horário
              comercial. O texto fica em Configurações → Templates →{" "}
              <em>Lembrete na triagem sem resposta</em>.
            </p>
          </div>
          <Switch
            checked={cfg.triagem_lembrete_ativo}
            disabled={toggleLembreteMut.isPending}
            onCheckedChange={(v) => toggleLembreteMut.mutate(v)}
            className="scale-125"
          />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Tempo de espera (minutos)
            </label>
            <Input
              type="number"
              min={5}
              max={240}
              step={1}
              value={lembreteMin}
              onChange={(e) => setLembreteMin(e.target.value)}
              disabled={!cfg.triagem_lembrete_ativo || saveLembreteMinMut.isPending}
              className="w-32"
            />
          </div>
          <Button
            onClick={() => {
              const n = parseInt(lembreteMin, 10);
              if (!Number.isFinite(n) || n < 5 || n > 240) {
                toast.error("Informe um valor entre 5 e 240 minutos.");
                return;
              }
              saveLembreteMinMut.mutate(n);
            }}
            disabled={
              !cfg.triagem_lembrete_ativo ||
              saveLembreteMinMut.isPending ||
              parseInt(lembreteMin, 10) === cfg.triagem_lembrete_minutos
            }
          >
            {saveLembreteMinMut.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Salvar tempo
          </Button>
        </div>
      </div>

      {/* Bloco 1.9 — Aviso ao colaborador quando cai um pendente */}
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">
              Avisar colaboradores de novos pendentes
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Quando ligado, sempre que um cliente cai como pendente em um departamento, o sistema
              manda uma mensagem no WhatsApp pessoal de todos os colaboradores ativos daquele
              departamento avisando que há cliente para atender. O administrador não recebe (ele já
              é avisado quando o atendimento atrasa). O texto fica em Configurações → Templates →{" "}
              <em>Aviso ao colaborador (novo pendente)</em>.
            </p>
          </div>
          <Switch
            checked={cfg.notificar_colaboradores_pendente}
            disabled={toggleNotifColabMut.isPending}
            onCheckedChange={(v) => toggleNotifColabMut.mutate(v)}
            className="scale-125"
          />
        </div>

        {cfg.notificar_colaboradores_pendente && !ativo && (
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <AlertTriangle className="h-5 w-5 shrink-0" strokeWidth={2} />
            <div className="font-medium">
              Avisos pausados — o bot está desligado. Eles voltam assim que o bot for religado.
            </div>
          </div>
        )}
      </div>

      {/* Bloco 1.95 — Encerramento automático por inatividade */}
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">
              Encerrar atendimentos parados por inatividade
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Quando ligado, todo atendimento reservado ou em andamento que ficar o tempo
              configurado sem nenhuma mensagem (de lado nenhum) é encerrado sozinho, em silêncio — o
              cliente não recebe aviso. Ajuste o tempo em Configurações → Tempos →{" "}
              <em>Encerrar atendimento parado por inatividade</em>. Desligado, o atendimento só
              encerra quando o atendente encerra na mão.
            </p>
          </div>
          <Switch
            checked={cfg.encerramento_automatico_ativo}
            disabled={toggleEncerramentoMut.isPending}
            onCheckedChange={(v) => toggleEncerramentoMut.mutate(v)}
            className="scale-125"
          />
        </div>

        {!cfg.encerramento_automatico_ativo && (
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">
            <XCircle className="h-5 w-5 shrink-0" strokeWidth={2} />
            <div className="font-medium">
              Só encerramento manual — nenhum atendimento é fechado automaticamente por falta de
              mensagem.
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpenPendentes} onOpenChange={setConfirmOpenPendentes}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Ligar modo emergência?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Isso libera a leitura cruzada de <strong>pendentes</strong> entre departamentos.
              Conversas sensíveis de outros departamentos (Contábil, DP, etc.) ficarão visíveis para
              qualquer atendente até alguém atendê-las. Mensagens de atendimentos já em andamento
              continuam isoladas. Desligue assim que a triagem voltar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => togglePendentesMut.mutate(true)}
            >
              Ligar mesmo assim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bloco 2 — Reativação programada */}
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-foreground">Reativação programada</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Bot será religado automaticamente nesta data pelo cron de reativação.
        </p>

        {/* Celular: botão de data e ações de agendamento empilham em largura
            cheia — os 260px fixos do botão de data já tomavam quase toda a
            tela em 360px, sem sobrar espaço pros botões de ação ao lado. */}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full justify-start text-left font-normal sm:w-[260px]",
                  !date && "text-muted-foreground",
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {date ? format(date, "PPP", { locale: ptBR }) : "Selecione uma data"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={date}
                onSelect={setDate}
                disabled={(d) => d < new Date(new Date().setHours(0, 0, 0, 0))}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>

          <Button
            className="w-full sm:w-auto"
            onClick={() => date && saveDateMut.mutate(format(date, "yyyy-MM-dd"))}
            disabled={!date || saveDateMut.isPending}
          >
            {saveDateMut.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Salvar agendamento
          </Button>

          {cfg.bot_ativacao_programada && (
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => {
                setDate(undefined);
                saveDateMut.mutate(null);
              }}
              disabled={saveDateMut.isPending}
            >
              Cancelar agendamento
            </Button>
          )}
        </div>

        {cfg.bot_ativacao_programada && (
          <p className="mt-3 text-xs text-muted-foreground">
            Agendamento atual:{" "}
            <strong>
              {format(new Date(cfg.bot_ativacao_programada), "PPP", { locale: ptBR })}
            </strong>
          </p>
        )}
      </div>

      {/* Bloco 3 — Impacto */}
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-foreground">Impacto do desligamento</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Confira o que para e o que continua quando o bot está desligado.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-rose-200 bg-muted p-4">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-rose-800">
              <XCircle className="h-4 w-4" /> Para de funcionar
            </h4>
            <ul className="mt-3 space-y-1.5 text-sm text-rose-900/80">
              {STOPS.map((s) => (
                <li key={s} className="flex items-start gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-rose-700" />
                  {s}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-muted p-4">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 className="h-4 w-4" /> Continua funcionando
            </h4>
            <ul className="mt-3 space-y-1.5 text-sm text-emerald-900/80">
              {KEEPS.map((s) => (
                <li key={s} className="flex items-start gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-emerald-700" />
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
