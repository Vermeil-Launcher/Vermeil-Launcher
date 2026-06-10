import { Component, Show, For, createMemo } from "solid-js";
import {
  activeScreen,
  setActiveScreen,
  Screen,
  instances,
  setActiveInstanceId,
  activeInstanceId,
  gameRunning,
  setGameRunning,
  ensureAccountOrPrompt,
  showToast,
  pinnedInstanceIds,
  pinSelectorOpen,
  setPinSelectorOpen,
  setInitialInstanceTab,
} from "../App";
import {
  IconHome,
  IconGrid,
  IconDownload,
  IconSettings,
  IconUser,
  IconShirt,
  IconPlus,
  IconPlay,
} from "./Icons";
import { launchInstance, stopInstance } from "../ipc/commands";
import { openPinInstancesModal } from "../modals/PinInstancesModal";

/**
 * Bottom-centered floating dock — single unified pill with a FAB-style
 * center action button raised above it.
 *
 * Two modes:
 *
 * 1. NAV (default): shows the 6 navigation buttons split around a notch
 *    that the FAB sits over. The FAB is state-aware: "+" when no instance
 *    is selected, "▶" when viewing one, "■" when the game is running.
 *
 * 2. PIN SELECTOR: when the user presses the `toggle_pin_selector`
 *    keybind (default Ctrl+P), the nav buttons fade out and a horizontal
 *    scrollable carousel of pinned instances takes their place. The FAB
 *    morphs into a "✕" close button. Clicking a pin opens that instance
 *    and closes the selector.
 */

const FloatingDock: Component = () => {
  const isActive = (screens: Screen[]) => screens.includes(activeScreen());

  const DockBtn = (props: { screens: Screen[]; target: Screen; icon: any; label: string }) => (
    <button
      type="button"
      class={`dock-btn ${isActive(props.screens) ? "active" : ""}`}
      onClick={() => {
        setActiveScreen(props.target);
        if (props.target !== "mods") setActiveInstanceId(null);
      }}
      data-tooltip={props.label}
    >
      {props.icon}
    </button>
  );

  /** Resolve pin IDs to live instances, filtering out deletions. */
  const pinnedInstances = () => {
    const list = instances();
    if (!list) return [];
    const ids = pinnedInstanceIds();
    return ids
      .map((id) => list.find((inst) => inst.id === id))
      .filter((inst): inst is NonNullable<typeof inst> => !!inst);
  };

  const openPinned = (id: string) => {
    setActiveInstanceId(id);
    setInitialInstanceTab("content");
    setActiveScreen("mods");
    setPinSelectorOpen(false);
  };

  /**
   * Center button state — drives icon, color, and click action.
   * Order of precedence (highest first):
   *   1. Pin selector open  → "✕" close
   *   2. Game running       → "■" stop
   *   3. Viewing an instance → "▶" play
   *   4. Default            → "+" create
   */
  type CenterMode = "close" | "stop" | "play" | "create";
  const centerMode = createMemo<CenterMode>(() => {
    if (pinSelectorOpen()) return "close";
    if (gameRunning()) return "stop";
    if (activeScreen() === "mods" && activeInstanceId()) return "play";
    return "create";
  });

  const centerLabel = () => {
    switch (centerMode()) {
      case "close": return "Close pin selector";
      case "stop": return "Stop game";
      case "play":
        const inst = instances()?.find((i) => i.id === activeInstanceId());
        return inst ? `Play ${inst.name}` : "Play";
      case "create": return "New instance";
    }
  };

  const handleCenterClick = async () => {
    const mode = centerMode();
    if (mode === "close") {
      setPinSelectorOpen(false);
      return;
    }
    if (mode === "create") {
      setActiveScreen("create-choose");
      return;
    }
    if (mode === "stop") {
      try {
        await stopInstance();
        setGameRunning(false);
      } catch (e) {
        showToast({ title: "Stop failed", message: String(e), type: "error" });
      }
      return;
    }
    // mode === "play"
    if (!ensureAccountOrPrompt()) return;
    const id = activeInstanceId();
    if (!id) return;
    setGameRunning(true);
    try {
      await launchInstance(id);
    } catch (e) {
      setGameRunning(false);
      showToast({ title: "Launch failed", message: String(e), type: "error" });
    }
  };

  return (
    <div class={`dock-wrap ${pinSelectorOpen() ? "pin-mode" : ""}`}>
      <div class="dock">
        {/* NAV MODE — the default 6-button layout. */}
        <Show when={!pinSelectorOpen()}>
          <div class="dock-group dock-group-left">
            <DockBtn screens={["home"]} target="home" icon={<IconHome />} label="Home" />
            <DockBtn
              screens={["library", "mods", "create-choose", "create-custom", "create-modpack", "create-import"]}
              target="library"
              icon={<IconGrid />}
              label="Library"
            />
            <DockBtn screens={["skins"]} target="skins" icon={<IconShirt />} label="Skins" />
          </div>

          <div class="dock-notch" aria-hidden="true" />

          <div class="dock-group dock-group-right">
            <DockBtn screens={["downloads"]} target="downloads" icon={<IconDownload />} label="Downloads" />
            <DockBtn screens={["settings"]} target="settings" icon={<IconSettings />} label="Settings" />
            <DockBtn screens={["account"]} target="account" icon={<IconUser />} label="Account" />
          </div>
        </Show>

        {/* PIN SELECTOR MODE — horizontal scrollable carousel of pins. */}
        <Show when={pinSelectorOpen()}>
          <div class="dock-pin-carousel">
            <Show
              when={pinnedInstances().length > 0}
              fallback={
                <div class="dock-pin-empty">
                  <span>No pinned instances</span>
                  <button
                    type="button"
                    class="dock-pin-empty-btn"
                    onClick={() => {
                      setPinSelectorOpen(false);
                      openPinInstancesModal();
                    }}
                  >
                    Pin some
                  </button>
                </div>
              }
            >
              {/* Scrollable row. The center FAB sits above the middle so we
                  give horizontal padding on both sides to not crowd it. */}
              <div class="dock-pin-track">
                <For each={pinnedInstances()}>
                  {(inst, i) => {
                    const iconSrc = () =>
                      inst.icon && inst.icon !== "cube" ? inst.icon : undefined;
                    return (
                      <button
                        type="button"
                        class={`dock-pin-tile loader-${inst.loader.type === "neoforge" ? "neoforge" : inst.loader.type}`}
                        style={`animation-delay:${i() * 35}ms`}
                        onClick={() => openPinned(inst.id)}
                        title={inst.name}
                      >
                        <div class="dock-pin-tile-img">
                          <Show
                            when={iconSrc()}
                            fallback={
                              <span class="dock-pin-tile-letter">
                                {inst.name.trim().charAt(0).toUpperCase() || "?"}
                              </span>
                            }
                          >
                            <img src={iconSrc()!} alt="" draggable={false} />
                          </Show>
                        </div>
                        <span class="dock-pin-tile-name">{inst.name}</span>
                      </button>
                    );
                  }}
                </For>
                <button
                  type="button"
                  class="dock-pin-tile dock-pin-tile-manage"
                  onClick={() => {
                    setPinSelectorOpen(false);
                    openPinInstancesModal();
                  }}
                  title="Manage pinned instances"
                >
                  <div class="dock-pin-tile-img">
                    <IconPlus />
                  </div>
                  <span class="dock-pin-tile-name">Manage</span>
                </button>
              </div>
            </Show>
          </div>
        </Show>

        {/* Center FAB — visible in both modes, swaps action via centerMode. */}
        <button
          type="button"
          class={`dock-center dock-center-${centerMode()}`}
          onClick={handleCenterClick}
          data-tooltip={centerLabel()}
        >
          <span class="dock-center-icon" key={centerMode()}>
            <Show when={centerMode() === "play"}>
              <IconPlay />
            </Show>
            <Show when={centerMode() === "create"}>
              <IconPlus />
            </Show>
            <Show when={centerMode() === "stop"}>
              <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
            </Show>
            <Show when={centerMode() === "close"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </Show>
          </span>
        </button>
      </div>
    </div>
  );
};

export default FloatingDock;
