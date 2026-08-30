import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "@/App";
import { AppStateProvider } from "@/state/app-state";
import "@/index.css";

const Router=import.meta.env.PROD?HashRouter:BrowserRouter;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </Router>
  </React.StrictMode>,
);
