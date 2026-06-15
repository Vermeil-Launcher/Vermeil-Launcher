import { Component, createSignal, onCleanup, onMount } from "solid-js";
import { formatBindingForDisplay, formatBindingFromEvent } from "../lib/keybinds";
import { IconRotateCcw } from "./Icons";

/**
 * Inline keybind editor — shows the current binding as a "key cap"
 * pill. Click to enter capture mode; the next non-modifier key combo
 * pressed becomes the new binding. Escape cancels capture.
 *
 * Used by Settings → Keybinds tab. Reset button restores the action's
 * default by passing an empty string to `onChange`.
 */
const KeybindCapture: Component<{
  binding: string;
  defaultBinding: string;
  onChange: (newBinding: string) => void;
}> = (props) => {
  const [capturing, setCapturing] = createSignal(false);
  let captureRef: HTMLButtonElement | undefined;

  const startCapture = () => {
    setCapturing(true);
    // Defer focus so the click handler that opened capture doesn't immediately
    // count as the captured key.
    setTimeout(() => captureRef?.focus(), 0);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!capturing()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturing(false);
      return;
    }
    const formatted = formatBindingFromEvent(e);
    if (!formatted) return; // modifier-only, keep listening
    props.onChange(formatted);
    setCapturing(false);
  };

  const handleReset = (e: MouseEvent) => {
    e.stopPropagation();
    // Pass empty string — App.tsx + the resolveBinding helper will fall
    // back to the action's default. Storing the default literal would
    // freeze it if we ever change defaults later.
    props.onChange("");
  };

  // Capture mode has its own document-level listener so the user can
  // press anything (Ctrl+T overrides browser tab open, etc.).
  onMount(() => {
    const handler = (e: KeyboardEvent) => handleKeyDown(e);
    document.addEventListener("keydown", handler, true);
    onCleanup(() => document.removeEventListener("keydown", handler, true));
  });

  // Click outside while capturing → cancel.
  onMount(() => {
    const handler = (e: MouseEvent) => {
      if (!capturing()) return;
      if (e.target === captureRef) return;
      setCapturing(false);
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

  const isDefault = () => !props.binding || props.binding === props.defaultBinding;

  return (
    <div class="keybind-capture-row">
      <button
        ref={captureRef}
        type="button"
        class={`keybind-capture ${capturing() ? "capturing" : ""}`}
        onClick={startCapture}
        title={capturing() ? "Press a key combination… (Escape to cancel)" : "Click to change"}
      >
        {capturing() ? (
          <span class="keybind-capturing-text">Press keys…</span>
        ) : (
          <span class="keybind-keys">{formatBindingForDisplay(props.binding || props.defaultBinding)}</span>
        )}
      </button>
      <button
        type="button"
        class="keybind-reset"
        onClick={handleReset}
        disabled={isDefault()}
        title="Reset to default"
      >
        <IconRotateCcw />
      </button>
    </div>
  );
};

export default KeybindCapture;
