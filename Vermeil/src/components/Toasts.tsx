import { Component, For, createSignal } from "solid-js";

export interface ToastAction {
  /** Visible button label. */
  label: string;
  /** Click handler. The toast auto-dismisses after this fires unless
   *  `keepOpen` is true. */
  onClick: () => void;
  /** When true, clicking the action does NOT dismiss the toast (e.g. a
   *  link opener that should let the user keep reading). */
  keepOpen?: boolean;
}

export interface Toast {
  id: string;
  title: string;
  message?: string;
  type: "info" | "success" | "warning" | "error";
  autoCloseMs?: number;
  /** Optional CTA rendered next to the dismiss button. */
  action?: ToastAction;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);

/** Show a toast notification. Returns the toast ID for manual dismissal. */
export function showToast(toast: Omit<Toast, "id">): string {
  const id = Math.random().toString(36).slice(2);
  const entry: Toast = { ...toast, id };
  setToasts((prev) => [...prev, entry].slice(-5)); // max 5 visible

  const autoClose = toast.autoCloseMs ?? 5000;
  if (autoClose > 0) {
    // Use a visibility-aware countdown so toasts don't silently expire while
    // the window is unfocused (alt-tabbed). The timer only ticks down while
    // the document is visible, ensuring the user always sees the toast for
    // its full duration.
    let remaining = autoClose;
    let last = performance.now();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        remaining -= (performance.now() - last);
        if (remaining <= 0) {
          clearInterval(interval);
          dismissToast(id);
        }
      }
      last = performance.now();
    }, 250);
  }
  return id;
}

/** Dismiss a specific toast by ID. */
export function dismissToast(id: string) {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

const typeIcons: Record<Toast["type"], string> = {
  info: "ℹ",
  success: "✓",
  warning: "⚠",
  error: "✕",
};

const Toasts: Component = () => {
  return (
    <div class="toast-container">
      <For each={toasts()}>
        {(toast) => (
          <div class={`toast-item toast-${toast.type}`}>
            <span class="toast-icon">{typeIcons[toast.type]}</span>
            <div class="toast-body">
              <div class="toast-title">{toast.title}</div>
              {toast.message && <div class="toast-msg">{toast.message}</div>}
            </div>
            {toast.action && (
              <button
                class="toast-action"
                onClick={() => {
                  toast.action!.onClick();
                  if (!toast.action!.keepOpen) dismissToast(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button class="toast-dismiss" onClick={() => dismissToast(toast.id)}>✕</button>
          </div>
        )}
      </For>
    </div>
  );
};

export default Toasts;
