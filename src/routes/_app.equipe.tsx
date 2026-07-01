import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, UserCog, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { listEquipe, listDepartamentos, criarMembro, type PapelEquipe } from "@/lib/equipe-queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_app/equipe")({
  staticData: { title: "Equipe" },
  component: EquipePage,
});

const PAPEL_LABEL: Record<PapelEquipe, string> = {
  dono: "Dono",
  administrador: "Administrador",
  colaborador: "Colaborador",
};

function EquipePage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const equipeQ = useQuery({ queryKey: ["equipe"], queryFn: listEquipe });
  const deptQ = useQuery({ queryKey: ["equipe-departamentos"], queryFn: listDepartamentos });

  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [papel, setPapel] = useState<"administrador" | "colaborador">("colaborador");
  const [deptId, setDeptId] = useState<string>("");

  function resetForm() {
    setNome("");
    setEmail("");
    setSenha("");
    setPapel("colaborador");
    setDeptId("");
  }

  const criar = useMutation({
    mutationFn: () =>
      criarMembro({
        nome: nome.trim(),
        email: email.trim().toLowerCase(),
        password: senha,
        role: papel,
        department_id: papel === "colaborador" ? deptId || null : null,
      }),
    onSuccess: () => {
      toast.success("Atendente criado. Passe a senha temporária para a pessoa.");
      qc.invalidateQueries({ queryKey: ["equipe"] });
      resetForm();
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (nome.trim().length < 2) return toast.error("Informe o nome");
    if (!email.trim()) return toast.error("Informe o e-mail");
    if (senha.length < 8) return toast.error("Senha temporária: mínimo 8 caracteres");
    if (papel === "colaborador" && !deptId) return toast.error("Escolha o departamento");
    criar.mutate();
  }

  const membros = equipeQ.data ?? [];
  const semDepartamentos = (deptQ.data?.length ?? 0) === 0;

  const rolesResumo = useMemo(() => {
    const list = equipeQ.data ?? [];
    const dono = list.filter((m) => m.role === "dono").length;
    const admin = list.filter(
      (m) => m.role === "administrador" || (m.isSuperadmin && m.role !== "dono"),
    ).length;
    const colab = list.length - dono - admin;
    return { dono, admin, colab };
  }, [equipeQ.data]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <UserCog className="h-6 w-6 text-primary" strokeWidth={1.75} />
            Equipe
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Crie e gerencie quem acessa o atendimento. {rolesResumo.dono} dono · {rolesResumo.admin}{" "}
            admin · {rolesResumo.colab} colaborador(es).
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" />
          Novo atendente
        </Button>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>Papel</TableHead>
              <TableHead>Departamento</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {equipeQ.isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : membros.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  Nenhum atendente ainda.
                </TableCell>
              </TableRow>
            ) : (
              membros.map((m) => {
                const papelLabel = m.role
                  ? PAPEL_LABEL[m.role]
                  : m.isSuperadmin
                    ? "Administrador"
                    : "Colaborador";
                return (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.nome}</TableCell>
                    <TableCell className="text-muted-foreground">{m.email ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={m.role === "dono" ? "default" : "secondary"}>
                        {papelLabel}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.departmentNome ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={m.ativo ? "outline" : "secondary"}>
                        {m.ativo ? "Ativo" : "Inativo"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Novo atendente</DialogTitle>
              <DialogDescription>
                Defina uma senha temporária — a pessoa será obrigada a trocá-la no primeiro acesso.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="m-nome">Nome</Label>
                <Input
                  id="m-nome"
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-email">E-mail</Label>
                <Input
                  id="m-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="pessoa@empresa.com.br"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-senha">Senha temporária</Label>
                <Input
                  id="m-senha"
                  type="text"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  placeholder="Mínimo 8 caracteres"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Papel</Label>
                <Select value={papel} onValueChange={(v) => setPapel(v as typeof papel)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="colaborador">Colaborador (atendente)</SelectItem>
                    <SelectItem value="administrador">Administrador</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {papel === "colaborador" && (
                <div className="space-y-1.5">
                  <Label>Departamento</Label>
                  <Select value={deptId} onValueChange={setDeptId} disabled={semDepartamentos}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          semDepartamentos ? "Cadastre um departamento primeiro" : "Escolha…"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(deptQ.data ?? []).map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.nome}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={criar.isPending}>
                {criar.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Criar atendente"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
