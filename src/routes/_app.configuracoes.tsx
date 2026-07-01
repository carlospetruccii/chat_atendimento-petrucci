import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { TemposTab } from "@/components/TemposTab";
import { HorarioTab } from "@/components/HorarioTab";
import { TemplatesTab } from "@/components/TemplatesTab";
import { ColaboradoresTab } from "@/components/ColaboradoresTab";
import { DepartamentosTab } from "@/components/DepartamentosTab";
import { AssuntosTab } from "@/components/AssuntosTab";
import { RoteamentoTab } from "@/components/RoteamentoTab";
import { OperacaoTab } from "@/components/OperacaoTab";

export const Route = createFileRoute("/_app/configuracoes")({
  staticData: { title: "Configurações" },
  component: ConfiguracoesPage,
});

const BASE_TABS = [
  "Departamentos",
  "Assuntos",
  "Roteamento",
  "Tempos",
  "Horário",
  "Templates",
  "Colaboradores",
  "Operação",
];

function EmBreve({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent">
        <Sparkles className="h-6 w-6 text-primary" strokeWidth={1.5} />
      </div>
      <h3 className="mt-4 text-base font-medium text-foreground">{name} — Em breve</h3>
      <p className="mt-1 text-sm text-muted-foreground">Esta seção estará disponível nas próximas versões.</p>
    </div>
  );
}

function ConfiguracoesPage() {
  const tabs = BASE_TABS;
  const [active, setActive] = useState("Departamentos");

  return (
    <>
      <div className="border-b border-border">
        <div className="flex gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setActive(t)}
              className={`px-4 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
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

      <div className="mt-6 animate-in fade-in duration-150">
        {active === "Departamentos" && <DepartamentosTab />}
        {active === "Assuntos" && <AssuntosTab />}
        {active === "Roteamento" && <RoteamentoTab />}
        {active === "Tempos" && <TemposTab />}
        {active === "Horário" && <HorarioTab />}
        {active === "Templates" && <TemplatesTab />}
        {active === "Colaboradores" && <ColaboradoresTab />}
        {active === "Operação" && <OperacaoTab />}
        {!tabs.includes(active) && <EmBreve name={active} />}
      </div>
    </>
  );
}
