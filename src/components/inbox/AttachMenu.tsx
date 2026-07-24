import { useRef, useState } from "react";
import {
  Paperclip,
  FileText,
  Image as ImageIcon,
  Camera,
  Headphones,
  User,
  BarChart3,
  CalendarDays,
  Smile,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MAX_BYTES = MAX_ATTACHMENT_BYTES;

export type AttachKind = "document" | "media" | "camera";

export interface PickedFile {
  file: File;
  kind: AttachKind;
}

interface Props {
  disabled?: boolean;
  onPick: (picked: PickedFile) => void;
  onError: (msg: string) => void;
}

const ACCEPT: Record<AttachKind, string> = {
  document:
    "application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  media: "image/*,video/*",
  camera: "image/*",
};

export function AttachMenu({ disabled, onPick, onError }: Props) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingKind, setPendingKind] = useState<AttachKind>("document");

  const trigger = (kind: AttachKind) => {
    setPendingKind(kind);
    setOpen(false);
    // pequeno delay para o popover fechar antes do file picker abrir
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.value = "";
      el.accept = ACCEPT[kind];
      if (kind === "camera") el.setAttribute("capture", "environment");
      else el.removeAttribute("capture");
      el.click();
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      onError("Arquivo muito grande (máx 16 MB).");
      return;
    }
    onPick({ file, kind: pendingKind });
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Anexar"
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <Paperclip className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-60 p-2"
        >
          <ul className="flex flex-col">
            <MenuItem
              icon={<FileText className="h-5 w-5" />}
              iconBg="bg-violet-500/15 text-violet-600 dark:text-violet-400"
              label="Documento"
              onClick={() => trigger("document")}
            />
            <MenuItem
              icon={<ImageIcon className="h-5 w-5" />}
              iconBg="bg-muted text-blue-600 dark:text-blue-400"
              label="Fotos e vídeos"
              onClick={() => trigger("media")}
            />
            <MenuItem
              icon={<Camera className="h-5 w-5" />}
              iconBg="bg-pink-500/15 text-pink-600 dark:text-pink-400"
              label="Câmera"
              onClick={() => trigger("camera")}
            />
            <MenuItem
              icon={<Headphones className="h-5 w-5" />}
              iconBg="bg-orange-500/15 text-orange-600 dark:text-orange-400"
              label="Áudio"
              hint="em breve"
              disabled
            />
            <MenuItem
              icon={<User className="h-5 w-5" />}
              iconBg="bg-sky-500/15 text-sky-600 dark:text-sky-400"
              label="Contato"
              hint="em breve"
              disabled
            />
            <MenuItem
              icon={<BarChart3 className="h-5 w-5" />}
              iconBg="bg-amber-500/15 text-amber-600 dark:text-amber-400"
              label="Enquete"
              hint="em breve"
              disabled
            />
            <MenuItem
              icon={<CalendarDays className="h-5 w-5" />}
              iconBg="bg-rose-500/15 text-rose-600 dark:text-rose-400"
              label="Evento"
              hint="em breve"
              disabled
            />
            <MenuItem
              icon={<Smile className="h-5 w-5" />}
              iconBg="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              label="Nova figurinha"
              hint="em breve"
              disabled
            />
          </ul>
        </PopoverContent>
      </Popover>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={handleChange}
      />
    </>
  );
}

function MenuItem({
  icon,
  iconBg,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-full ${iconBg}`}
        >
          {icon}
        </span>
        <span className="flex-1 text-foreground">{label}</span>
        {hint ? (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </button>
    </li>
  );
}
