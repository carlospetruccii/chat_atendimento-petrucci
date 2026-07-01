import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  QrCode,
  RefreshCw,
  Smartphone,
  WifiOff,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_app/conexao")({
  staticData: { title: "Conexão do WhatsApp" },
  component: ConexaoPage,
});

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

async function chamar<T>(action: "status" | "connect" | "disconnect"): Promise<T> {
  const { data, error } = await supabase.functions.invoke("whatsapp-connection", {
    body: { action },
  });
  if (error) throw error;
  return data as T;
}

function ConexaoPage() {
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

  const disconnectM = useMutation({
    mutationFn: () => chamar<{ ok: boolean }>("disconnect"),
    onSuccess: () => {
      setQr(null);
      setPaircode(null);
      toast.success("WhatsApp desconectado.");
      qc.invalidateQueries({ queryKey: ["whatsapp-status"] });
    },
    onError: () => toast.error("Falha ao desconectar."),
  });

  const qrSrc = qr ? (qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`) : null;
  const numero = statusQ.data?.numero;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent">
          <Smartphone className="h-5 w-5 text-primary" strokeWidth={1.75} />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">Conexão do WhatsApp</h1>
          <p className="text-sm text-muted-foreground">
            Conecte o número da Almore escaneando o QR code com o celular.
          </p>
        </div>
      </div>

      {/* Carregando o status pela primeira vez */}
      {statusQ.isLoading && (
        <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Verificando conexão…
        </div>
      )}

      {/* uazapi ainda não configurada no servidor */}
      {!statusQ.isLoading && naoConfig && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <h2 className="text-base font-semibold">WhatsApp ainda não configurado</h2>
          <p className="mt-1 text-sm">
            As credenciais da conta uazapi ainda não foram cadastradas no servidor.
            Assim que forem, esta tela permitirá escanear o QR code e conectar o número.
          </p>
        </div>
      )}

      {/* Conectado */}
      {!statusQ.isLoading && !naoConfig && conectado && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-6 w-6 text-emerald-500" />
            <div>
              <h2 className="text-base font-semibold text-foreground">Conectado</h2>
              <p className="text-sm text-muted-foreground">
                {statusQ.data?.profileName ? `${statusQ.data.profileName} · ` : ""}
                {numero ? `+${numero}` : "número ativo"}
              </p>
            </div>
          </div>
          <div className="mt-6 flex gap-2">
            <button
              type="button"
              onClick={() => disconnectM.mutate()}
              disabled={disconnectM.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {disconnectM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <WifiOff className="h-4 w-4" />}
              Desconectar
            </button>
            <button
              type="button"
              onClick={() => statusQ.refetch()}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              <RefreshCw className="h-4 w-4" /> Atualizar
            </button>
          </div>
        </div>
      )}

      {/* Desconectado — mostrar/gerar QR */}
      {!statusQ.isLoading && !naoConfig && !conectado && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-3">
            <WifiOff className="h-6 w-6 text-muted-foreground" />
            <div>
              <h2 className="text-base font-semibold text-foreground">Desconectado</h2>
              <p className="text-sm text-muted-foreground">
                Escaneie o QR code para conectar o número da Almore.
              </p>
            </div>
          </div>

          {qrSrc ? (
            <div className="mt-6 flex flex-col items-center">
              <div className="rounded-xl border border-border bg-white p-3">
                <img src={qrSrc} alt="QR code para conectar o WhatsApp" className="h-64 w-64" />
              </div>
              <ol className="mt-4 max-w-sm list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Abra o WhatsApp no celular da Almore.</li>
                <li>Toque em <strong>Aparelhos conectados</strong>.</li>
                <li>Toque em <strong>Conectar um aparelho</strong> e escaneie este código.</li>
              </ol>
              {paircode && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Ou use o código de pareamento: <span className="font-mono font-semibold text-foreground">{paircode}</span>
                </p>
              )}
              <button
                type="button"
                onClick={() => connectM.mutate()}
                disabled={connectM.isPending}
                className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                {connectM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Gerar novo QR code
              </button>
            </div>
          ) : (
            <div className="mt-6">
              <button
                type="button"
                onClick={() => connectM.mutate()}
                disabled={connectM.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {connectM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                Gerar QR code
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
