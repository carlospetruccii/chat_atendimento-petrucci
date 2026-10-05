import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuthSession } from "@/hooks/useAuthSession";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/trocar-senha")({
  component: TrocarSenhaPage,
});

function TrocarSenhaPage() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading } = useAuthSession();
  const [senha, setSenha] = useState("");
  const [confirma, setConfirma] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Sem sessão não há o que trocar → volta para o login.
  useEffect(() => {
    if (!sessionLoading && !session) navigate({ to: "/login" });
  }, [session, sessionLoading, navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (senha.length < 8) {
      toast.error("A nova senha precisa ter ao menos 8 caracteres");
      return;
    }
    if (senha !== confirma) {
      toast.error("As senhas não conferem");
      return;
    }
    setSubmitting(true);
    // Troca a senha E limpa o marcador de "senha temporária" na mesma chamada.
    const { error } = await supabase.auth.updateUser({
      password: senha,
      data: { must_change_password: false },
    });
    setSubmitting(false);

    if (error) {
      toast.error(error.message || "Não foi possível trocar a senha");
      return;
    }
    toast.success("Senha atualizada");
    navigate({ to: "/inbox" });
  }

  async function handleSair() {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  }

  return (
    // min-h-dvh (não min-h-screen): com o teclado aberto, 100vh continua sendo a
    // tela inteira e o card fica atrás dele. overflow-y-auto + py-8 garantem que,
    // se o teclado encolher demais o espaço, dá pra rolar até o topo do card em
    // vez de ele simplesmente cortar sem jeito de alcançar.
    <div className="flex min-h-dvh items-center justify-center overflow-y-auto bg-background px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <KeyRound className="h-7 w-7" strokeWidth={1.75} />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Defina sua senha</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Você entrou com uma senha temporária. Escolha uma senha nova para continuar.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="senha">Nova senha</Label>
            <Input
              id="senha"
              type="password"
              autoComplete="new-password"
              placeholder="Mínimo 8 caracteres"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirma">Repita a nova senha</Label>
            <Input
              id="confirma"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={confirma}
              onChange={(e) => setConfirma(e.target.value)}
              disabled={submitting}
            />
          </div>
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar e continuar"}
          </Button>
          <button
            type="button"
            onClick={handleSair}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
          >
            Sair
          </button>
        </form>
      </div>
    </div>
  );
}
