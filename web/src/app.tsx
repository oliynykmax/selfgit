import { toast } from "@ui-sdk/react/toast";
import { useEffect } from "react";
import { Header } from "@/components/header";
import { Problem } from "@/components/states";
import { Toaster } from "@/components/toaster";
import { navigate, useLocation } from "@/lib/navigation";
import { parseRoute } from "@/lib/route";
import { Home } from "@/pages/home";
import { RepoPage } from "@/pages/repo";

const SIGN_IN_MESSAGES: Record<string, string> = {
  denied: "Only the owner's GitHub account can sign in here.",
  cancelled: "Sign-in was cancelled.",
  expired: "Sign-in took too long. Try again.",
  failed: "GitHub sign-in failed. Try again.",
};

function useSignInNotice(search: string) {
  useEffect(() => {
    const outcome = new URLSearchParams(search).get("signin");
    if (!outcome) return;
    const message = SIGN_IN_MESSAGES[outcome];
    if (message) toast.error(message);
    navigate(location.pathname, { replace: true });
  }, [search]);
}

export function App() {
  const { pathname, search } = useLocation();
  useSignInNotice(search);
  const route = parseRoute(pathname);
  const title =
    route.kind === "home" || route.kind === "not-found"
      ? "git.oliinyk.dev"
      : `${route.repo} · git.oliinyk.dev`;
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <>
      <Header />
      {route.kind === "home" ? <Home /> : null}
      {route.kind === "not-found" ? (
        <main className="mx-auto max-w-6xl px-4 py-8">
          <Problem title="Page not found" detail="This page does not exist." />
        </main>
      ) : null}
      {route.kind !== "home" && route.kind !== "not-found" ? (
        <RepoPage key={route.repo} route={route} />
      ) : null}
      <Toaster />
    </>
  );
}
