import { Component, For, Show, createSignal } from "solid-js";
import { IconChevronDown } from "./Icons";

interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  /** Optional width constraint */
  width?: string;
  /** When true, the control is greyed out and can't be opened. */
  disabled?: boolean;
  /** Open the options panel upward (above the trigger) instead of downward.
   *  Use when the dropdown sits near the bottom of its container so the list
   *  doesn't overflow and trigger a scrollbar. */
  openUp?: boolean;
}

/**
 * Custom styled dropdown that matches the game version selector design.
 * Replaces native <select> elements for consistent cross-platform appearance.
 */
const Dropdown: Component<DropdownProps> = (props) => {
  const [open, setOpen] = createSignal(false);

  const selectedLabel = () => {
    const opt = props.options.find(o => o.value === props.value);
    return opt?.label ?? props.value;
  };

  return (
    <div
      class="custom-dropdown"
      classList={{ disabled: props.disabled }}
      style={props.width ? `width:${props.width}` : "width:auto;min-width:120px"}
      tabIndex={props.disabled ? -1 : 0}
      onBlur={() => setTimeout(() => setOpen(false), 150)}
    >
      <div
        class="custom-dropdown-selected"
        style="padding:4px 10px;font-size:11px;border-radius:0"
        onClick={() => { if (!props.disabled) setOpen(!open()); }}
      >
        <span>{selectedLabel()}</span>
        <span class="custom-dropdown-arrow" classList={{ open: open() }}><IconChevronDown /></span>
      </div>
      <Show when={open() && !props.disabled}>
        <div class="custom-dropdown-options" classList={{ up: props.openUp }} style="max-height:180px">
          <For each={props.options}>
            {(opt) => (
              <div
                class="custom-dropdown-option"
                classList={{ selected: props.value === opt.value }}
                onClick={() => { props.onChange(opt.value); setOpen(false); }}
              >
                {opt.label}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default Dropdown;
