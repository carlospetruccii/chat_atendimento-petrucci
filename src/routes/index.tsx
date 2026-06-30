import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sua Empresa" },
      { name: "description", content: "Landing page simples e moderna." },
      { property: "og:title", content: "Sua Empresa" },
      { property: "og:description", content: "Landing page simples e moderna." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link to="/" className="text-xl font-bold tracking-tight">
            Logo
          </Link>
          <nav className="hidden gap-6 text-sm font-medium text-muted-foreground sm:flex">
            <Link to="/" className="transition-colors hover:text-foreground">
              Home
            </Link>
            <Link to="/" className="transition-colors hover:text-foreground">
              Sobre
            </Link>
            <Link to="/" className="transition-colors hover:text-foreground">
              Contato
            </Link>
          </nav>
          <Button size="sm">Começar</Button>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
              Sua headline principal aqui
            </h1>
            <p className="mt-6 text-lg text-muted-foreground">
              Uma descrição breve do que você faz. Mantenha simples, clara e direta ao ponto.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button size="lg">Ação principal</Button>
              <Button variant="outline" size="lg">
                Saiba mais
              </Button>
            </div>
          </div>
        </section>

        <section className="border-t border-border bg-muted/30">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
              <FeatureCard
                title="Feature 1"
                description="Breve descrição deste benefício ou funcionalidade."
              />
              <FeatureCard
                title="Feature 2"
                description="Breve descrição deste benefício ou funcionalidade."
              />
              <FeatureCard
                title="Feature 3"
                description="Breve descrição deste benefício ou funcionalidade."
              />
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
          <div className="rounded-2xl border border-border bg-card p-8 text-card-foreground sm:p-12">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-bold tracking-tight">Pronto para começar?</h2>
              <p className="mt-4 text-muted-foreground">
                Texto de apoio para converter visitantes em ação.
              </p>
              <div className="mt-8">
                <Button size="lg">Chamada para ação</Button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-sm text-muted-foreground sm:flex-row sm:px-6 lg:px-8">
          <p>© {new Date().getFullYear()} Sua Empresa. Todos os direitos reservados.</p>
          <div className="flex gap-6">
            <Link to="/" className="hover:text-foreground">
              Termos
            </Link>
            <Link to="/" className="hover:text-foreground">
              Privacidade
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 text-card-foreground">
      <div className="mb-4 h-10 w-10 rounded-lg bg-primary/10" />
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

