import { Component, For, Show, createSignal } from "solid-js";

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
      style={props.width ? `width:${props.width}` : "width:auto;min-width:120px"}
      tabIndex={0}
      onBlur={() => setTimeout(() => setOpen(false), 150)}
    >
      <div
        class="custom-dropdown-selected"
        style="padding:4px 10px;font-size:11px;border-radius:6px"
        onClick={() => setOpen(!open())}
      >
        <span>{selectedLabel()}</span>
        <span class="custom-dropdown-arrow" classList={{ open: open() }}>▾</span>
      </div>
      <Show when={open()}>
        <div class="custom-dropdown-options" style="max-height:180px">
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
