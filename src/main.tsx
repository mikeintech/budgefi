import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "@/App";
import { AppStateProvider } from "@/state/app-state";
import { OptionalAuthProvider } from "@/components/auth-provider";
import { NativeRuntime } from "@/components/native-runtime";
import { isNativeApp } from "@/lib/platform";
import "@/index.css";

const Router=isNativeApp||import.meta.env.VITE_ROUTER_MODE==="hash"?HashRouter:BrowserRouter;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OptionalAuthProvider><Router><AppStateProvider><NativeRuntime>
      <App />
    </NativeRuntime></AppStateProvider></Router></OptionalAuthProvider>
  </React.StrictMode>,
);
