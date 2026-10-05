import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  cadastrarClienteSingle,
  type ClienteAutocompleteRow,
  formatTelefoneBR,
  searchClientesAutocomplete,
} from "@/lib/clientes-queries";
import { iniciarDocsConversa } from "@/lib/docs-queries";
import { avisoCadastro } from "@/lib/cadastro-aviso";

/** Nome mínimo aceito no cadastro rápido (mesma régua do Iniciar atendimento). */
const MIN_NOME = 2;
const MIN_BUSCA = 2;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Conversa aberta/reaberta com você como dono. */
  onIniciada: (conversaId: string) => void;
}

/**
 * "Nova conversa" do Docs: escolhe o cliente (o cadastro é o mesmo da Inbox) e
 * abre a conversa pelo número financeiro já com você como dono. Sem
 * departamento nem atendente — no Docs quem inicia é quem responde.
 */
export function DocsNovaConversaDialog({ open, onOpenChange, onIniciada }: Props) {
  const [busca, setBusca] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selecionado, setSelecionado] = useState<ClienteAutocompleteRow | null>(null);
  const [novo, setNovo] = useState<{ nome: string; telefone: string } | null>(null);
  const [salvandoNovo, setSalvandoNovo] = useState(false);
  const [iniciando, setIniciando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusca("");
    setDebounced("");
    setSelecionado(null);
    setNovo(null);
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(busca.trim()), 200);
    return () => clearTimeout(t);
  }, [busca]);

  const sugestoesQ = useQuery({
    queryKey: ["clientes-autocomplete", debounced],
    queryFn: () => searchClientesAutocomplete(debounced, 10),
    enabled: open && !selecionado && debounced.length >= MIN_BUSCA,
  });
  const sugestoes = sugestoesQ.data ?? [];
  const semResultado =
    debounced.length >= MIN_BUSCA && !sugestoesQ.isLoading && sugestoes.length === 0;

  const abrirNovo = () => {
    const soDigitos = /^\+?[\d\s()-]+$/.test(busca.trim());
    setNovo(soDigitos ? { nome: "", telefone: busca } : { nome: busca, telefone: "" });
  };

  const salvarNovo = async () => {
    if (!novo) return;
    if (novo.nome.trim().length < MIN_NOME) {
      toast.error("Nome precisa ter ao menos 2 caracteres");
      return;
    }
    if (!novo.telefone.trim()) {
      toast.error("Telefone obrigatório");
      return;
    }
    setSalvandoNovo(true);
    try {
      const r = await cadastrarClienteSingle(novo.nome, novo.telefone);
      setSelecionado({
        id: r.cliente.id,
        nome: r.cliente.nome,
        numero_whatsapp: r.cliente.numero_whatsapp,
      });
      setNovo(null);
      toast.success(avisoCadastro(r, "Cliente"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao cadastrar cliente");
    } finally {
      setSalvandoNovo(false);
    }
  };

  const iniciar = async () => {
    if (!selecionado) return;
    setIniciando(true);
    try {
      const id = await iniciarDocsConversa(selecionado.id);
      toast.success("Conversa iniciada — ela é sua");
      onIniciada(id);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível iniciar a conversa.");
    } finally {
      setIniciando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !iniciando && onOpenChange(v)}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto scroll-contain">
        <DialogHeader>
          <DialogTitle>Nova conversa no Docs</DialogTitle>
          <DialogDescription>
            A mensagem sai pelo número financeiro e a conversa fica com você.
          </DialogDescription>
        </DialogHeader>

        {selecionado ? (
          <div className="flex items-center justify-between rounded-md border border-border bg-muted px-3 py-2">
            <div className="min-w-0 text-sm">
              <div className="truncate text-foreground">
                {selecionado.nome ?? <span className="italic text-muted-foreground">sem nome</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatTelefoneBR(selecionado.numero_whatsapp)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelecionado(null)}
              className="text-xs text-primary hover:underline"
            >
              Trocar
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar cliente por nome ou telefone..."
                className="pl-9"
              />
            </div>

            {debounced.length >= MIN_BUSCA && (
              <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                {sugestoesQ.isLoading && (
                  <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando...
                  </div>
                )}
                {sugestoes.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelecionado(c)}
                    className="w-full border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted"
                  >
                    <div className="text-foreground">
                      {c.nome ?? <span className="italic text-muted-foreground">sem nome</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatTelefoneBR(c.numero_whatsapp)}
                    </div>
                  </button>
                ))}
                {semResultado && !novo && (
                  <button
                    type="button"
                    onClick={abrirNovo}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-primary hover:bg-muted"
                  >
                    <UserPlus className="h-4 w-4" />
                    Adicionar novo cliente: <strong className="truncate">{busca}</strong>
                  </button>
                )}
              </div>
            )}

            {novo && (
              <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
                <div className="text-xs font-medium text-foreground">Novo cliente</div>
                <Input
                  value={novo.nome}
                  onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
                  placeholder="Nome"
                />
                <Input
                  value={novo.telefone}
                  onChange={(e) => setNovo({ ...novo, telefone: e.target.value })}
                  placeholder="Telefone (ex: 11999999999)"
                />
                <div className="flex justify-end gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={() => setNovo(null)}>
                    Cancelar
                  </Button>
                  <Button size="sm" onClick={salvarNovo} disabled={salvandoNovo}>
                    {salvandoNovo && <Loader2 className="h-3 w-3 animate-spin" />}
                    Salvar e selecionar
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={iniciando}>
            Cancelar
          </Button>
          <Button onClick={iniciar} disabled={!selecionado || iniciando}>
            {iniciando && <Loader2 className="h-4 w-4 animate-spin" />}
            Iniciar conversa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
