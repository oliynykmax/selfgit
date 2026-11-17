import { Avatar, AvatarFallback, AvatarImage } from "@ui-sdk/react/avatar";
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import { toast } from "@ui-sdk/react/toast";
import { LogOut, Moon, Sun } from "lucide-react";
import { useState } from "react";
import type { Session } from "../../../src/api-types";
import { Link } from "@/components/link";
import { buttonVariants } from "@/components/ui/button";
import { invalidate, send, useApi } from "@/lib/api";
import { useLocation } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function useSession(): Session | null {
  const session = useApi<Session>("/api/session");
  return session.status === "ok" ? session.data : null;
}

function AccountMenu({ login, avatarUrl }: { login: string; avatarUrl: string }) {
  async function signOut() {
    try {
      await send("/auth/logout", "POST");
      invalidate("/api/");
      toast("Signed out");
    } catch (error) {
      toast.error("Sign out failed", { description: error instanceof Error ? error.message : undefined });
    }
  }

  return (
    <Menu>
      <MenuTrigger aria-label={`Account ${login}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-2 px-1.5")}>
        <Avatar className="size-6 overflow-hidden rounded-full border">
          <AvatarImage src={avatarUrl} alt="" />
          <AvatarFallback className="grid size-full place-items-center bg-muted text-[0.65rem] font-medium uppercase">{login.slice(0, 2)}</AvatarFallback>
        </Avatar>
        <span className="hidden text-sm sm:inline">{login}</span>
      </MenuTrigger>
      <MenuContent className="min-w-48 rounded-lg border bg-popover p-1 text-sm shadow-md" align="end">
        <MenuGroup>
          <MenuGroupLabel className="px-2 py-1.5 text-xs text-muted-foreground">Signed in as {login}</MenuGroupLabel>
          <MenuItem value="sign-out" onSelect={signOut} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none data-highlighted:bg-muted">
            <LogOut className="size-4" />
            Sign out
          </MenuItem>
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

export function Header() {
  const session = useSession();
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const { pathname } = useLocation();
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
            <circle cx="6" cy="6" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="6" cy="18" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="18" cy="9" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M6 8.5v7M18 11.5c0 4-6 3-11 5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          git.oliinyk.dev
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={buttonVariants({ variant: "ghost", size: "sm" })} aria-label="Dark theme" aria-pressed={dark} onClick={() => {
            const next = !dark;
            document.documentElement.classList.toggle("dark", next);
            setDark(next);
            try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* Storage is blocked, so the choice lasts for this page only. */ }
          }}>
            {dark ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}
          </button>
          {session?.authenticated ? (
            <AccountMenu login={session.login} avatarUrl={session.avatarUrl} />
          ) : session ? (
            <a href={`/auth/github/login?next=${encodeURIComponent(pathname)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Sign in
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
}
