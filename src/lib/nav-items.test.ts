import { describe, expect, test } from "vitest";
import { canSee, menuItems, splitMobileNav, visibleItems } from "./nav-items";
import type { CurrentUserProfile } from "@/hooks/useCurrentUser";

const perfil = (over: Partial<CurrentUserProfile>): CurrentUserProfile => ({
  id: "u1",
  nome: "Fulano",
  email: null,
  departmentId: null,
  departmentNome: null,
  departmentCor: null,
  isSuperadmin: false,
  permissions: [],
  ...over,
});

const docs = menuItems.find((i) => i.url === "/docs");

describe("item Docs do menu", () => {
  test("existe, com badge próprio", () => {
    expect(docs).toBeDefined();
    expect(docs?.badgeKey).toBe("docs");
  });

  test("admin vê sem precisar da permissão", () => {
    expect(canSee(docs!, perfil({ isSuperadmin: true }))).toBe(true);
  });

  test("colaborador só vê com docs_acesso", () => {
    expect(canSee(docs!, perfil({ permissions: ["docs_acesso"] }))).toBe(true);
    expect(canSee(docs!, perfil({ permissions: ["view_all_departments"] }))).toBe(false);
    expect(canSee(docs!, null)).toBe(false);
  });

  test("colaborador com acesso tem o Docs na barra do celular", () => {
    const { bar } = splitMobileNav(visibleItems(perfil({ permissions: ["docs_acesso"] })));
    expect(bar.map((i) => i.url)).toContain("/docs");
  });
});
