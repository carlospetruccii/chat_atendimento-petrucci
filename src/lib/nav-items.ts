import {
  ContactRound,
  Hourglass,
  Inbox,
  LayoutDashboard,
  ScanEye,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { CurrentUserProfile } from "@/hooks/useCurrentUser";
import type { NavBadges } from "@/hooks/useNavBadges";

export type MenuGate = undefined | { superadminOnly: true } | { anyOf: string[] };

export type MenuItem = {
  title: string;
  /** Rótulo curto para a barra inferior do celular, onde não cabe "Configurações". */
  shortTitle?: string;
  url: string;
  icon: LucideIcon;
  gate?: MenuGate;
  /** Amarrado às chaves de NavBadges: um typo aqui vira erro de compilação,
   *  não um badge que some sem avisar. */
  badgeKey?: keyof NavBadges;
};

/**
 * Navegação principal, na ordem da régua lateral do desktop.
 *
 * Mora aqui, e não dentro do AppSidebar, porque a barra inferior do celular
 * (MobileNav) precisa exatamente da mesma lista e das mesmas travas de
 * permissão. Duas cópias divergiriam no primeiro item novo.
 */
export const menuItems: MenuItem[] = [
  {
    title: "Dashboard",
    url: "/dashboard",
    icon: LayoutDashboard,
    gate: { anyOf: ["view_all_departments"] },
  },
  { title: "Inbox", url: "/inbox", icon: Inbox, badgeKey: "inbox" },
  {
    title: "Pendentes",
    shortTitle: "Pend.",
    url: "/pendentes",
    icon: Hourglass,
    badgeKey: "pendentes",
  },
  { title: "Contatos", url: "/contatos", icon: ContactRound },
  {
    title: "Supervisão",
    url: "/supervisao",
    icon: ScanEye,
    gate: { anyOf: ["view_all_departments"] },
  },
  {
    title: "Configurações",
    shortTitle: "Config.",
    url: "/configuracoes",
    icon: SlidersHorizontal,
    gate: { superadminOnly: true },
  },
];

/**
 * Ordem de prioridade da barra inferior do celular. Diferente do desktop de
 * propósito: no celular só cabem 4 destinos, então os de uso diário vêm antes.
 * O que sobrar cai no menu do avatar.
 */
const PRIORIDADE_MOBILE: readonly string[] = [
  "/inbox",
  "/pendentes",
  "/contatos",
  "/dashboard",
];

/** Quantos destinos cabem na barra inferior antes do slot do avatar. */
export const MOBILE_NAV_SLOTS = 4;

export function canSee(item: MenuItem, user: CurrentUserProfile | null): boolean {
  if (!item.gate) return true;
  if (!user) return false;
  if ("superadminOnly" in item.gate) return user.isSuperadmin;
  if ("anyOf" in item.gate) {
    return user.isSuperadmin || item.gate.anyOf.some((f) => user.permissions.includes(f));
  }
  return false;
}

export function visibleItems(user: CurrentUserProfile | null): MenuItem[] {
  return menuItems.filter((item) => canSee(item, user));
}

/**
 * Divide os itens visíveis entre a barra inferior e o menu do avatar.
 * Quem enxerga tudo (superadmin) tem 7 destinos; 7 ícones numa barra de celular
 * viram alvos minúsculos, então só os 4 primeiros (MOBILE_NAV_SLOTS) ficam na
 * barra e o resto vai para o menu.
 */
export function splitMobileNav(items: MenuItem[]): { bar: MenuItem[]; overflow: MenuItem[] } {
  const porPrioridade = [...items].sort((a, b) => {
    const ia = PRIORIDADE_MOBILE.indexOf(a.url);
    const ib = PRIORIDADE_MOBILE.indexOf(b.url);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return {
    bar: porPrioridade.slice(0, MOBILE_NAV_SLOTS),
    overflow: porPrioridade.slice(MOBILE_NAV_SLOTS),
  };
}
