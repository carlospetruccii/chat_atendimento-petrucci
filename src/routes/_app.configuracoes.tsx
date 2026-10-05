import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { TemposTab } from "@/components/TemposTab";
import { HorarioTab } from "@/components/HorarioTab";
import { TemplatesTab } from "@/components/TemplatesTab";
import { ColaboradoresTab } from "@/components/ColaboradoresTab";
import { DepartamentosTab } from "@/components/DepartamentosTab";
import { OperacaoTab } from "@/components/OperacaoTab";
import { GoogleContatosTab } from "@/components/GoogleContatosTab";
import { SessoesTab } from "@/components/SessoesTab";
import { SemTriagemSection } from "@/components/SemTriagemSection";
import { ConexaoWhatsAppTab } from "@/components/ConexaoWhatsAppTab";

export const Route = createFileRoute("/_app/configuracoes")({
  staticData: { title: "Configurações" },
  component: ConfiguracoesPage,
});

const BASE_TABS = [
  "Departamentos",
  "Tempos",
  "Horário",
  "Templates",
  "Colaboradores",
  "Operação",
  "Lista de Sessões",
  "Contatos Google",
  "Conexão do WhatsApp",
];

function EmBreve({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent">
        <Sparkles className="h-6 w-6 text-primary" strokeWidth={1.5} />
      </div>
      <h3 className="mt-4 text-base font-medium text-foreground">{name} — Em breve</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Esta seção estará disponível nas próximas versões.
      </p>
    </div>
  );
}

function ConfiguracoesPage() {
  const tabs = BASE_TABS;
  const [active, setActive] = useState("Departamentos");

  return (
    <>
      <div className="border-b border-border">
        {/* Celular: 9 abas não cabem lado a lado. Rolagem horizontal com snap
            (em vez de esconder as abas atrás de um <Select>) porque os
            rótulos são curtos e reconhecíveis — a pessoa já sabe onde cada
            aba fica e prefere continuar vendo todas, só deslizando o dedo.
            no-scrollbar/scroll-contain/snap-* vêm da fundação (styles.css). */}
        <div className="flex gap-1 overflow-x-auto no-scrollbar scroll-contain snap-x-mandatory">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setActive(t)}
              className={`shrink-0 snap-start-always whitespace-nowrap border-b-2 -mb-px px-4 py-3 text-sm transition-colors sm:py-2.5 ${
                active === t
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 animate-in fade-in duration-150 sm:mt-6">
        {active === "Departamentos" && <DepartamentosTab />}
        {active === "Tempos" && <TemposTab />}
        {active === "Horário" && <HorarioTab />}
        {active === "Templates" && <TemplatesTab />}
        {active === "Colaboradores" && <ColaboradoresTab />}
        {active === "Operação" && <OperacaoTab />}
        {active === "Lista de Sessões" && (
          <div className="space-y-8 sm:space-y-12">
            <SessoesTab />
            <div className="border-t border-border" />
            <SemTriagemSection />
          </div>
        )}
        {active === "Contatos Google" && <GoogleContatosTab />}
        {active === "Conexão do WhatsApp" && <ConexaoWhatsAppTab />}
        {!tabs.includes(active) && <EmBreve name={active} />}
      </div>
    </>
  );
}
