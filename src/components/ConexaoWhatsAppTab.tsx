import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2, QrCode, RefreshCw, Smartphone, WifiOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface StatusResp {
  ok: boolean;
  erro?: string;
  detalhe?: string;
  connected?: boolean;
  loggedIn?: boolean;
  status?: string | null;
  profileName?: string | null;
  numero?: string | null;
}

interface ConnectResp {
  ok: boolean;
  erro?: string;
  detalhe?: string;
  connected?: boolean;
  loggedIn?: boolean;
  qrcode?: string | null;
  paircode?: string | null;
}

async function chamar<T>(action: "status" | "connect"): Promise<T> {
  const { data, error } = await supabase.functions.invoke("whatsapp-connection", {
    body: { action },
  });
  if (error) throw error;
  return data as T;
}

const HORA_FORMATADA = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

export function ConexaoWhatsAppTab() {
  const qc = useQueryClient();
  const [qr, setQr] = useState<string | null>(null);
  const [paircode, setPaircode] = useState<string | null>(null);

  const statusQ = useQuery({
    queryKey: ["whatsapp-status"],
    queryFn: () => chamar<StatusResp>("status"),
    refetchInterval: (q) => {
      const d = q.state.data as StatusResp | undefined;
      if (d?.erro === "uazapi_nao_configurado") return 20_000;
      return d?.connected && d?.loggedIn ? 15_000 : 4_000;
    },
  });

  const conectado = Boolean(statusQ.data?.connected && statusQ.data?.loggedIn);
  const naoConfig = statusQ.data?.erro === "uazapi_nao_configurado";

  // Ao conectar, limpa o QR/pareamento da tela.
  useEffect(() => {
    if (conectado) {
      setQr(null);
      setPaircode(null);
    }
  }, [conectado]);

  const connectM = useMutation({
    mutationFn: () => chamar<ConnectResp>("connect"),
    onSuccess: (d) => {
      if (!d.ok) {
        toast.error(d.detalhe || "Não foi possível iniciar a conexão.");
        return;
      }
      if (d.connected && d.loggedIn) {
        setQr(null);
        toast.success("WhatsApp já está conectado.");
      } else if (d.qrcode) {
        setQr(d.qrcode);
        setPaircode(d.paircode ?? null);
      } else {
        toast.message("Gerando QR code…");
      }
      qc.invalidateQueries({ queryKey: ["whatsapp-status"] });
    },
    onError: () => toast.error("Falha ao falar com o servidor."),
  });

  const qrSrc = qr ? (qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`) : null;
  const numero = statusQ.data?.numero;
  const ultimaVerificacao = statusQ.dataUpdatedAt
    ? HORA_FORMATADA.format(new Date(statusQ.dataUpdatedAt))
    : "—";

  return (
    <div className="mx-auto max-w-md text-center">
      <div className="mb-8 flex flex-col items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15">
          <Smartphone className="h-5 w-5 text-primary" strokeWidth={1.75} />
        </div>
        <h2 className="text-base font-semibold text-foreground">Conexão do WhatsApp</h2>
        <p className="text-sm text-muted-foreground">
          Saúde do número da Parabrisas Petrucci no sistema.
        </p>
      </div>

      {/* Carregando o status pela primeira vez */}
      {statusQ.isLoading && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Verificando conexão…
        </div>
      )}

      {/* uazapi ainda não configurada no servidor */}
      {!statusQ.isLoading && naoConfig && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <h3 className="text-base font-semibold">WhatsApp ainda não configurado</h3>
          <p className="mt-1 text-sm">
            As credenciais da conta uazapi ainda não foram cadastradas no servidor. Assim que forem,
            esta aba permitirá escanear o QR code e conectar o número.
          </p>
        </div>
      )}

      {/* Conectado: saúde OK */}
      {!statusQ.isLoading && !naoConfig && conectado && (
        <div className="rounded-3xl border border-primary/30 bg-primary/5 px-6 py-8">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-primary/15 ring-8 ring-primary/10">
            <CheckCircle2 className="h-9 w-9 text-primary" strokeWidth={1.75} />
          </div>
          <h3 className="mt-5 text-lg font-semibold text-primary">Conectado</h3>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            {statusQ.data?.profileName ?? "Número ativo"}
          </p>

          <dl className="mx-auto mt-6 grid max-w-xs grid-cols-2 gap-x-4 gap-y-3 border-t border-primary/20 pt-6 text-left text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="flex items-center justify-end gap-2 font-medium text-foreground">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              Online
            </dd>
            <dt className="text-muted-foreground">Número</dt>
            <dd className="text-right font-medium text-foreground">
              {numero ? `+${numero}` : "—"}
            </dd>
            <dt className="text-muted-foreground">Última verificação</dt>
            <dd className="text-right font-medium text-foreground">{ultimaVerificacao}</dd>
          </dl>

          <button
            type="button"
            onClick={() => statusQ.refetch()}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-primary/30 bg-card px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/10 sm:w-auto"
          >
            <RefreshCw className="h-4 w-4" /> Verificar agora
          </button>
        </div>
      )}

      {/* Desconectado: mostrar/gerar QR para reconectar */}
      {!statusQ.isLoading && !naoConfig && !conectado && (
        <div className="rounded-3xl border border-border bg-card px-6 py-8">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-muted">
            <WifiOff className="h-9 w-9 text-muted-foreground" strokeWidth={1.75} />
          </div>
          <h3 className="mt-5 text-lg font-semibold text-foreground">Desconectado</h3>
          <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
            Escaneie o QR code para conectar o número da Parabrisas Petrucci.
          </p>

          {qrSrc ? (
            <div className="mt-6 flex flex-col items-center">
              {/* w-full + max-w-64 deixa o QR encolher até caber em telas de 320px
                  e aspect-square mantém o quadrado. */}
              <div className="w-full max-w-64 rounded-xl border border-border bg-white p-3">
                <img
                  src={qrSrc}
                  alt="QR code para conectar o WhatsApp"
                  className="aspect-square h-auto w-full"
                />
              </div>
              <ol className="mx-auto mt-5 max-w-xs list-decimal space-y-1 pl-5 text-left text-sm text-muted-foreground">
                <li>Abra o WhatsApp no celular da Parabrisas Petrucci.</li>
                <li>
                  Toque em <strong>Aparelhos conectados</strong>.
                </li>
                <li>
                  Toque em <strong>Conectar um aparelho</strong> e escaneie este código.
                </li>
              </ol>
              {paircode && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Ou use o código de pareamento:{" "}
                  <span className="font-mono font-semibold text-foreground">{paircode}</span>
                </p>
              )}
              <button
                type="button"
                onClick={() => connectM.mutate()}
                disabled={connectM.isPending}
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50 sm:w-auto"
              >
                {connectM.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Gerar novo QR code
              </button>
            </div>
          ) : (
            <div className="mt-6">
              <button
                type="button"
                onClick={() => connectM.mutate()}
                disabled={connectM.isPending}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 sm:w-auto"
              >
                {connectM.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <QrCode className="h-4 w-4" />
                )}
                Gerar QR code
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
