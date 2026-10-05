import type { MensagemRenderizavel } from "@/lib/mensagem-shape";
import type { EscopoMidia } from "@/lib/midia-acoes";
import { MediaLoading } from "./MediaLoading";
import { MediaError } from "./MediaError";
import { MediaImage } from "./MediaImage";
import { MediaAudio } from "./MediaAudio";
import { MediaVideo } from "./MediaVideo";
import { MediaDocument } from "./MediaDocument";
import { MediaSticker } from "./MediaSticker";
import { MediaContato } from "./MediaContato";

interface MediaMeta {
  storage_path?: string;
  download_falhou?: boolean;
  /** 'grande_demais' = não cabe no Storage; tentar de novo não resolve. */
  download_erro_codigo?: string;
  download_erro_bytes?: number;
  file_name?: string;
  tamanho_bytes?: number;
  duration_seconds?: number;
  duracao_seg?: number;
  caption?: string;
  vcard?: string;
}

function isHttpUrl(value: string | null): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

// Serve chat individual e grupo: só precisa do conteúdo, não do vínculo.
// `escopo` diz em qual tabela a mensagem está, para o botão "Tentar novamente"
// saber o que reprocessar. Sem escopo (ex.: chat interno, que tem tabela
// própria e mídia enviada por nós) a bolha de erro vai sem o botão.
export function MessageMedia({
  message,
  escopo,
}: {
  message: MensagemRenderizavel;
  escopo?: EscopoMidia;
}) {
  const meta = (message.mediaMetadata ?? {}) as MediaMeta;

  if (message.tipo === "contato") {
    return (
      <MediaContato
        vcard={typeof meta.vcard === "string" ? meta.vcard : null}
        nomeExibicao={message.content}
      />
    );
  }

  // Tipos sem download (texto não chega aqui, mas este também)
  if (message.tipo === "localizacao") {
    return (
      <p className="italic text-muted-foreground text-sm">
        [{message.tipo}] {message.content ?? ""}
      </p>
    );
  }

  // Estado: falha → pronta → baixando (ordem importa)
  if (meta.download_falhou === true) {
    return (
      <MediaError
        tipo={message.tipo}
        mensagemId={message.id}
        escopo={escopo}
        grandeDemaisBytes={
          meta.download_erro_codigo === "grande_demais"
            ? (meta.download_erro_bytes ?? 0)
            : undefined
        }
      />
    );
  }

  const storagePath = typeof meta.storage_path === "string" ? meta.storage_path : null;
  if (message.tipo === "sticker" && !storagePath && isHttpUrl(message.mediaUrl)) {
    return <img src={message.mediaUrl} alt="Sticker" className="h-32 w-32 object-contain" />;
  }

  if (!storagePath) {
    return <MediaLoading tipo={message.tipo} />;
  }

  const caption = meta.caption ?? message.content ?? null;

  switch (message.tipo) {
    case "imagem":
      return <MediaImage storagePath={storagePath} caption={caption} />;
    case "audio":
      return (
        <MediaAudio
          storagePath={storagePath}
          durationSeconds={meta.duracao_seg ?? meta.duration_seconds}
        />
      );
    case "video":
      return <MediaVideo storagePath={storagePath} caption={caption} />;
    case "documento":
      return (
        <MediaDocument
          storagePath={storagePath}
          fileName={meta.file_name}
          sizeBytes={meta.tamanho_bytes}
          caption={caption}
        />
      );
    case "sticker":
      return <MediaSticker storagePath={storagePath} />;
    default:
      return (
        <p className="italic text-muted-foreground text-sm">
          [{message.tipo}] {message.content ?? ""}
        </p>
      );
  }
}
