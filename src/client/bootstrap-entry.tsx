import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Application } from "./application";
import "./tailwind.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing Toki root");
createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <Application />
    </BrowserRouter>
  </StrictMode>,
);
