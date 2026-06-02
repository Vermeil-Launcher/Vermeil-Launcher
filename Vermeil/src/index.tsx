/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./styles/global.css";
import { openUrl } from "@tauri-apps/plugin-opener";

// Native app behavior: suppress browser shortcuts and context menu in production
if (!import.meta.env.DEV) {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {
    // Suppress find-in-page, view-source, and dev tools
    if (
      (e.ctrlKey && e.key === "f") ||
      (e.ctrlKey && e.key === "u") ||
      e.key === "F12"
    ) {
      e.preventDefault();
    }
  });
}

// Intercept all external link clicks — open in system browser, not webview
document.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement)?.closest("a");
  if (!target) return;
  const href = target.getAttribute("href");
  if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
    e.preventDefault();
    openUrl(href);
  }
});

render(() => <App />, document.getElementById("root")!);
