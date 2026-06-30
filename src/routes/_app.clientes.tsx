import { createFileRoute } from "@tanstack/react-router";
import { ClientesTab } from "@/components/ClientesTab";

export const Route = createFileRoute("/_app/clientes")({
  staticData: { title: "Clientes" },
  component: ClientesPage,
});

function ClientesPage() {
  return <ClientesTab canManage={true} />;
}
