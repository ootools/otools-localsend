import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initializeTheme } from "./theme";
import "virtual:uno.css";
import "./styles.css";

initializeTheme();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
