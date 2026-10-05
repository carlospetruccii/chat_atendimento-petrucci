import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { setTemplateAtivo, updateTemplate } from "@/lib/configuracoes-queries";
import { buscarAvisoDocs, validarTextoAvisoDocs } from "@/lib/docs-config";

// Resposta automática do número financeiro: quando o cliente escreve nele, o
// sistema avisa que o número é só para documentos e passa o do atendimento.
// Edita o mesmo template da aba Templates (variações continuam lá).

const CHAVE = ["docs-aviso-automatico"] as const;

export function DocsRespostaAutomatica() {
  const qc = useQueryClient();
  const avisoQ = useQuery({ queryKey: CHAVE, queryFn: buscarAvisoDocs });
  const [texto, setTexto] = useState("");

  useEffect(() => {
    if (avisoQ.data) setTexto(avisoQ.data.texto);
  }, [avisoQ.data]);

  const invalidar = () => qc.invalidateQueries({ queryKey: CHAVE });

  const ativoM = useMutation({
    mutationFn: (ativo: boolean) => setTemplateAtivo(avisoQ.data!.id, ativo),
    onSuccess: (_d, ativo) => {
      toast.success(ativo ? "Resposta automática ligada." : "Resposta automática desligada.");
      invalidar();
    },
    onError: () => toast.error("Não foi possível salvar. Tente de novo."),
  });

  const salvarM = useMutation({
    mutationFn: () => updateTemplate(avisoQ.data!.id, texto.trim(), avisoQ.data!.variacoes),
    onSuccess: () => {
      toast.success("Texto da resposta automática salvo.");
      invalidar();
    },
    onError: () => toast.error("Não foi possível salvar o texto."),
  });

  if (avisoQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando…
      </div>
    );
  }
  if (avisoQ.isError || !avisoQ.data) {
    return (
      <p className="text-sm text-destructive">Não foi possível carregar a resposta automática.</p>
    );
  }

  const aviso = avisoQ.data;
  const validacao = validarTextoAvisoDocs(texto);
  const alterado = texto.trim() !== aviso.texto.trim();

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Avisar que o número é só de documentos
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Sai pelo número financeiro quando o cliente escreve: no máximo 1 vez a cada 3 horas por
            cliente, e nunca enquanto alguém está atendendo a conversa.
          </p>
        </div>
        <Switch
          checked={aviso.ativo}
          disabled={ativoM.isPending}
          onCheckedChange={(v) => ativoM.mutate(v)}
          aria-label="Ligar ou desligar a resposta automática"
        />
      </div>

      <div className="space-y-2">
        <Textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={5}
          aria-label="Texto da resposta automática"
        />
        {validacao.alerta && (
          <p className={`text-xs ${validacao.ok ? "text-amber-700" : "text-destructive"}`}>
            {validacao.alerta}
          </p>
        )}
        {aviso.variacoes.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Este aviso tem {aviso.variacoes.length} variação(ões) cadastrada(s) na aba Templates — o
            sistema sorteia entre elas.
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          disabled={!alterado || salvarM.isPending}
          onClick={() => setTexto(aviso.texto)}
        >
          Desfazer
        </Button>
        <Button
          disabled={!alterado || !validacao.ok || salvarM.isPending}
          onClick={() => salvarM.mutate()}
        >
          {salvarM.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Salvar texto
        </Button>
      </div>
    </div>
  );
}
