import {
  createFileRoute,
  Outlet,
  useMatches,
  useRouterState,
} from "@tanstack/react-router";
import { AppSidebar } from "@/components/AppSidebar";

export interface AppRouteStaticData {
  title?: string;
  noPadding?: boolean;
}

export const Route = createFileRoute("/_app")({
  component: AppLayoutRoute,
});

function AppLayoutRoute() {
  const matches = useMatches();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const staticData = (matches[matches.length - 1]?.staticData ?? {}) as AppRouteStaticData;
  const noPadding = !!staticData.noPadding;

  return (
    <div className="flex h-screen w-full bg-background">
      <AppSidebar />
      <main
        key={pathname}
        className={`flex-1 overflow-auto bg-background animate-in fade-in duration-150 ${
          noPadding ? "" : "p-8"
        }`}
      >
        <Outlet />
      </main>
    </div>
  );
}
