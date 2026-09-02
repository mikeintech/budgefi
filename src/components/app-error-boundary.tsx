import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";

type State = { failed: boolean };

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error("Budgefi UI boundary", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="paper-grain grid min-h-dvh place-items-center bg-paper p-5 text-ink">
      <main className="w-full max-w-[430px] rounded-[26px] border border-rule bg-sheet p-6 shadow-card" role="alert">
        <Wordmark />
        <span className="mt-8 grid size-12 place-items-center rounded-2xl bg-coral/10 text-coral"><AlertTriangle className="size-6" /></span>
        <h1 className="mt-5 text-[28px] font-bold tracking-[-.04em]">This page couldn’t open safely</h1>
        <p className="mt-2 text-sm leading-6 text-muted">Budgefi stopped before showing an incomplete state. Reload the page, or return to the previous screen without retrying the action.</p>
        <div className="mt-6 grid grid-cols-[auto_1fr] gap-2">
          <Button variant="outline" onClick={() => history.back()}><ArrowLeft className="size-4" />Back</Button>
          <Button onClick={() => location.reload()}><RefreshCw className="size-4" />Reload Budgefi</Button>
        </div>
      </main>
    </div>;
  }
}
