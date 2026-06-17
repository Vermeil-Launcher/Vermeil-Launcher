import { Component, Show, For, createMemo, createSignal, onMount, onCleanup } from "solid-js";
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
  dockHidden,
  dockPagination,
  clearGameLogs,
} from "../App";
import {
  IconHome,
  IconGrid,
  IconSettings,
  IconUser,
  IconShirt,
  IconPlus,
  IconPlay,
  IconDownload,
} from "./Icons";
import { launchInstance, stopInstance } from "../ipc/commands";
import { openPinInstancesModal, MAX_PINS } from "../modals/PinInstancesModal";

/**
 * Bottom-centered floating dock — single unified pill with a FAB-style
 * center action button raised above it.
 *
 * When pagination is active a second mini floating pill appears above the
 * dock with ‹ page/total › controls.
 */

const FloatingDock: Component = () => {
  const isActive = (screens: Screen[]) => screens.includes(activeScreen());

  const [nearBottom, setNearBottom] = createSignal(false);
  onMount(() => {
    const handler = (e: MouseEvent) => {
      setNearBottom(window.innerHeight - e.clientY < 90);
    };
    window.addEventListener("mousemove", handler);
    onCleanup(() => window.removeEventListener("mousemove", handler));
  });

  const hidden = () => dockHidden() && !nearBottom() && !pinSelectorOpen();

  const DockBtn = (props: { screens: Screen[]; target: Screen; icon: any; label: string }) => (
    <button
      type="button"
      class={`dock-btn ${isActive(props.screens) ? "active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setActiveScreen(props.target);
        if (props.target !== "mods") setActiveInstanceId(null);
      }}
      data-tooltip={props.label}
    >
      {props.icon}
    </button>
  );

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
    if (!ensureAccountOrPrompt()) return;
    const id = activeInstanceId();
    if (!id) return;
    setGameRunning(true);
    clearGameLogs(id);
    try {
      await launchInstance(id);
    } catch (e) {
      setGameRunning(false);
      showToast({ title: "Launch failed", message: String(e), type: "error" });
    }
  };

  return (
    <div class={`dock-wrap ${pinSelectorOpen() ? "pin-mode" : ""} ${hidden() ? "dock-hidden" : ""}`}>
      {/* Pagination island — iOS-style dot indicator.
          Shows a window of dots; current is bright/large, neighbors fade.
          Scroll wheel navigates. Hold to type a page number. */}
      <Show when={dockPagination() && !pinSelectorOpen()}>
        {(() => {
          const [holding, setHolding] = createSignal(false);
          const [inputValue, setInputValue] = createSignal("");
          // Wheel-on-island flash. While the user is scrolling pages, the
          // active dot expands to reveal its page number; a 600ms idle
          // debounce keeps it expanded during continuous scroll and only
          // collapses once the user actually stops.
          const [scrolling, setScrolling] = createSignal(false);
          let scrollResetTimer: number | undefined;
          const flashScroll = () => {
            setScrolling(true);
            if (scrollResetTimer !== undefined) window.clearTimeout(scrollResetTimer);
            scrollResetTimer = window.setTimeout(() => setScrolling(false), 600);
          };
          onCleanup(() => {
            if (scrollResetTimer !== undefined) window.clearTimeout(scrollResetTimer);
          });
          let holdTimer: number | undefined;
          let islandEl: HTMLDivElement | undefined;

          const startHold = () => {
            holdTimer = window.setTimeout(() => {
              setHolding(true);
              setInputValue(dockPagination()!.current.toString());
              setTimeout(() => {
                const input = islandEl?.querySelector<HTMLInputElement>(".dock-page-input");
                if (input) { input.focus(); input.select(); }
              }, 20);
            }, 500);
          };
          const cancelHold = () => {
            clearTimeout(holdTimer);
          };
          const submitInput = () => {
            const val = parseInt(inputValue());
            const pag = dockPagination();
            if (pag && val >= 1 && val <= pag.total) pag.onPageChange(val);
            setHolding(false);
          };

          // Build the visible dot window (max 7 dots centered on current page).
          const MAX_DOTS = 7;
          const dots = () => {
            const pag = dockPagination()!;
            const total = pag.total;
            const current = pag.current;
            const count = Math.min(MAX_DOTS, total);
            let start = Math.max(1, current - Math.floor(count / 2));
            if (start + count - 1 > total) start = Math.max(1, total - count + 1);
            const arr: number[] = [];
            for (let i = start; i < start + count; i++) arr.push(i);
            return arr;
          };

          return (
            <div
              class={`dock-page-island ${holding() ? "holding" : ""}`}
              ref={(el) => {
                islandEl = el;
                const handler = (e: WheelEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const pag = dockPagination();
                  if (!pag) return;
                  // Always flash on a wheel event so the user gets feedback
                  // even when they're already at the edge and the page can't
                  // change. Confirms "I heard you" instead of feeling dead.
                  flashScroll();
                  if (e.deltaY < 0 && pag.current < pag.total) {
                    pag.onPageChange(pag.current + 1);
                    if (holding()) setInputValue((pag.current + 1).toString());
                  } else if (e.deltaY > 0 && pag.current > 1) {
                    pag.onPageChange(pag.current - 1);
                    if (holding()) setInputValue((pag.current - 1).toString());
                  }
                };
                el.addEventListener("wheel", handler, { passive: false });
              }}
              onMouseDown={startHold}
              onMouseUp={cancelHold}
              onMouseLeave={cancelHold}
            >
              <Show when={!holding()}>
                <div class="dock-page-dots">
                  <For each={dots()}>
                    {(page) => {
                      const pag = () => dockPagination()!;
                      const isActive = () => page === pag().current;
                      const dist = () => Math.abs(page - pag().current);
                      return (
                        <div
                          class={`dock-dot ${isActive() ? "active" : ""} ${isActive() && scrolling() ? "expanded" : ""}`}
                          style={`opacity: ${Math.max(0.2, 1 - dist() * 0.2)}; transform: scale(${isActive() ? 1 : Math.max(0.5, 1 - dist() * 0.15)})`}
                          onClick={() => { pag().onPageChange(page); flashScroll(); }}
                        >
                          <Show when={isActive() && scrolling()}>
                            <span class="dock-dot-num">{page}</span>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
              <Show when={holding()}>
                <div class="dock-page-hold-input">
                  <input
                    class="dock-page-input"
                    type="text"
                    value={inputValue()}
                    onInput={(e) => setInputValue(e.currentTarget.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") submitInput(); if (e.key === "Escape") setHolding(false); }}
                    onBlur={submitInput}
                  />
                  <span class="dock-page-total">/ {dockPagination()!.total}</span>
                </div>
              </Show>
            </div>
          );
        })()}
      </Show>

      <div class="dock">
        {/* NAV MODE */}
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

        {/* PIN SELECTOR MODE */}
        <Show when={pinSelectorOpen()}>
          <div class="dock-pin-carousel">
            {/* Manage is anchored on the left; the remaining space holds the
                pinned tiles, or — when nothing is pinned yet — a centered hint
                explaining the feature and the pin cap. A right-side spacer
                mirrors the Manage tile so the middle stays truly centered.
                The carousel keeps a fixed width, so the pill never changes
                size between the empty and populated states. */}
            <div class="dock-pin-track">
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

              <div class="dock-pin-items">
                <Show
                  when={pinnedInstances().length > 0}
                  fallback={
                    <div class="dock-pin-hint">
                      <span class="dock-pin-hint-title">Pin up to {MAX_PINS} instances</span>
                      <span class="dock-pin-hint-sub">Quick-launch your favourites straight from the dock</span>
                    </div>
                  }
                >
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
                </Show>
              </div>

              <div class="dock-pin-spacer" aria-hidden="true" />
            </div>
          </div>
        </Show>

        {/* Center FAB */}
        <button
          type="button"
          class={`dock-center dock-center-${centerMode()}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleCenterClick}
          data-tooltip={centerLabel()}
        >
          <span class="dock-center-icon">
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
