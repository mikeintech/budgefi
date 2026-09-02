import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand";
import { useAuth } from "@clerk/react";
import { clerkConfigured } from "@/lib/auth";

export function NotFoundPage() {
  return clerkConfigured ? <AuthenticatedNotFoundPage /> : <NotFoundContent />;
}

function AuthenticatedNotFoundPage() {
  const session = useAuth();
  return <NotFoundContent signedIn={session.isLoaded && session.isSignedIn} />;
}

function NotFoundContent({ signedIn = false }: { signedIn?: boolean }) {
  const destination = signedIn ? "/today" : "/";
  const destinationLabel = destination === "/today" ? "Return to Today" : "Return home";
  return <main className="paper-grain grid min-h-dvh place-items-center bg-paper p-5">
    <section className="w-full max-w-[390px] rounded-[26px] border border-rule bg-sheet p-6 shadow-sheet">
      <Wordmark />
      <span className="mt-10 grid size-12 place-items-center rounded-2xl bg-pencil/8 text-pencil"><Compass className="size-6"/></span>
      <p className="eyebrow mt-5">Page not found</p>
      <h1 className="mt-1 text-[30px] font-bold tracking-[-.045em]">This path does not match a Budgefi page.</h1>
      <p className="mt-2 text-sm leading-6 text-muted">No financial record was changed. Return to a known page or use your browser’s back button.</p>
      <Button asChild size="lg" className="mt-6 w-full"><Link to={destination}>{destinationLabel}</Link></Button>
    </section>
  </main>;
}
