import { AudioLines, Forward, MoreVertical, Pencil, Reply, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type AcaoMensagem,
  avaliarAcao,
  type Elegibilidade,
  type MotivoBloqueio,
  textoMotivo,
} from "@/lib/janelas-whatsapp";
import { avaliarEncaminhar, paraEncaminhavel } from "@/lib/mensagem-encaminhar";
import { type MensagemAvaliavelNaTela, paraAvaliavel } from "@/hooks/useSelecaoMensagens";
import { audioTranscrevivel, usePedirTranscricao } from "@/hooks/useTranscricaoAudio";

interface MensagemAcoesMenuProps {
  /** Mensagem da Inbox ou do Docs (mesmo formato nos campos que o menu lê). */
  mensagem: MensagemAvaliavelNaTela;
  agora: number;
  onResponder: () => void;
  onEditar: () => void;
  onApagar: () => void;
  onEncaminhar: () => void;
  /**
   * Travas extras de quem usa o menu fora da Inbox (aba Docs: só o dono
   * responde; editar/apagar é do dono ou admin). Padrão `true` = Inbox, que
   * deixa essa régua inteira para o backend.
   */
  podeResponder?: boolean;
  podeEncaminhar?: boolean;
  podeAlterar?: boolean;
}

/**
 * Motivos que a pessoa NÃO precisa ver: são estruturais, valem para sempre e
 * mostrar "não é sua mensagem" desabilitado em toda mensagem do cliente só
 * poluiria o menu — o WhatsApp também não oferece a opção nesses casos.
 *
 * O que sobra ('fora_da_janela', 'tipo_nao_editavel') é o oposto: a ação EXISTIA
 * e deixou de existir. Aí o item aparece desabilitado com o motivo, que é
 * exatamente o aviso que o produto pediu.
 */
const MOTIVOS_OCULTOS: MotivoBloqueio[] = [
  "nao_e_saida_nossa",
  "nao_enviada",
  "sem_id_whatsapp",
  "ja_apagada",
];

function visivel(el: Elegibilidade): boolean {
  return el.pode || !MOTIVOS_OCULTOS.includes(el.motivo as MotivoBloqueio);
}

function ItemBloqueado({
  acao,
  motivo,
  icone,
  rotulo,
}: {
  acao: AcaoMensagem;
  motivo: MotivoBloqueio;
  icone: React.ReactNode;
  rotulo: string;
}) {
  return (
    <DropdownMenuItem disabled className="flex-col items-start gap-0.5">
      <span className="flex items-center gap-2">
        {icone}
        {rotulo}
      </span>
      <span className="pl-6 text-[10px] leading-snug">{textoMotivo(acao, motivo)}</span>
    </DropdownMenuItem>
  );
}

/**
 * Menu da bolha: responder, encaminhar, editar e apagar para todos. O gesto
 * principal de apagar em lote é segurar a mensagem (ver useLongPress); este
 * menu é o caminho de mouse e o único lugar onde "editar"/"encaminhar" aparecem.
 */
export function MensagemAcoesMenu({
  mensagem,
  agora,
  onResponder,
  onEditar,
  onApagar,
  onEncaminhar,
  podeResponder = true,
  podeEncaminhar = true,
  podeAlterar = true,
}: MensagemAcoesMenuProps) {
  const avaliavel = paraAvaliavel(mensagem);
  const podeEditar = avaliarAcao("editar", avaliavel, agora);
  const podeApagar = avaliarAcao("apagar", avaliavel, agora);
  // Sem janela de tempo (ver mensagem-encaminhar.ts): motivo sempre estrutural,
  // então — diferente de editar/apagar — não existe estado "desabilitado com
  // motivo", só mostra ou não mostra.
  const mostraEncaminhar = podeEncaminhar && avaliarEncaminhar(paraEncaminhavel(mensagem)).pode;

  const mostraEditar = podeAlterar && visivel(podeEditar);
  const mostraApagar = podeAlterar && visivel(podeApagar);
  const audioPath = audioTranscrevivel(mensagem);
  const pedirTranscricao = usePedirTranscricao();

  // Menu sem nenhum item não abre nada: some o botão. Na Inbox não acontece
  // (Responder está sempre lá); no Docs, quem só lê pode não ter ação.
  if (!podeResponder && !audioPath && !mostraEncaminhar && !mostraEditar && !mostraApagar) {
    return null;
  }

  function transcrever(storagePath: string) {
    // O texto aparece embaixo do player (MediaAudio lê o mesmo cache); aqui só
    // sobra avisar quando falha.
    pedirTranscricao(storagePath).catch((e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Não foi possível transcrever o áudio.");
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // opacity-0 + group-hover é feito para mouse: sem hover, o celular
          // nunca revelaria este botão (ficaria clicável mas invisível). Por
          // isso ele parte visível e some só a partir do md, onde o hover
          // existe de fato.
          className="touch-target-mobile inline-flex items-center justify-center rounded-full text-muted-foreground opacity-100 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 md:p-1.5 md:opacity-0 md:group-hover:opacity-100"
          aria-label="Ações da mensagem"
          title="Ações"
        >
          <MoreVertical className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {podeResponder && (
          <DropdownMenuItem onSelect={onResponder}>
            <Reply className="h-3.5 w-3.5" strokeWidth={1.5} />
            Responder
          </DropdownMenuItem>
        )}

        {audioPath && (
          <DropdownMenuItem onSelect={() => transcrever(audioPath)}>
            <AudioLines className="h-3.5 w-3.5" strokeWidth={1.5} />
            Transcrever áudio
          </DropdownMenuItem>
        )}

        {mostraEncaminhar && (
          <DropdownMenuItem onSelect={onEncaminhar}>
            <Forward className="h-3.5 w-3.5" strokeWidth={1.5} />
            Encaminhar
          </DropdownMenuItem>
        )}

        {(mostraEditar || mostraApagar) && <DropdownMenuSeparator />}

        {mostraEditar &&
          (podeEditar.pode ? (
            <DropdownMenuItem onSelect={onEditar}>
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
              Editar mensagem
            </DropdownMenuItem>
          ) : (
            <ItemBloqueado
              acao="editar"
              motivo={podeEditar.motivo as MotivoBloqueio}
              icone={<Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />}
              rotulo="Editar mensagem"
            />
          ))}

        {mostraApagar &&
          (podeApagar.pode ? (
            <DropdownMenuItem onSelect={onApagar} className="text-[#DC2626] focus:text-[#DC2626]">
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              Apagar para todos
            </DropdownMenuItem>
          ) : (
            <ItemBloqueado
              acao="apagar"
              motivo={podeApagar.motivo as MotivoBloqueio}
              icone={<Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />}
              rotulo="Apagar para todos"
            />
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
