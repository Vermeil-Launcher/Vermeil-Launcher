import { Component, createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { currentLogTarget, readInstanceLog, LogTarget } from "../ipc/commands";
import { IconSearch, IconArrowUp, IconArrowDown, IconX } from "../components/Icons";

/**
 * Standalone log viewer rendered in its own Tauri window ("logs" label).
 * index.tsx routes here when the URL carries `?popout=logs`. The window is
 * opened by the backend on launch when the `popout_logs` setting is on, so a
 * user who hides the launcher to the tray can still watch the game's output.
 *
 * This runs in a fresh webview with no shared app state, so it manages its
 * own line buffer: it seeds from the persisted `latest.log` on open, then
 * tails live `game-log` events filtered to the active instance. The backend's
 * `current_log_target` tells it which instance to show on mount, and a
 * `logs-load-instance` event re-points it when a different instance launches
 * while the window is already open.
 */
const LogsPopout: Component = () => {
  const appWindow = getCurrentWindow();
  // Cap the buffer so a chatty modpack logging tens of thousands of lines
  // can't grow the array and DOM unbounded. We keep the most recent lines,
  // which is what a tail-style viewer wants anyway.
  const MAX_LINES = 5000;
  const [instanceId, setInstanceId] = createSignal<string | null>(null);
  const [instanceName, setInstanceName] = createSignal("");
  const [lines, setLines] = createSignal<string[]>([]);
  const [filters, setFilters] = createSignal<Set<string>>(new Set(["all"]));
  const [search, setSearch] = createSignal("");
  const [autoScroll, setAutoScroll] = createSignal(true);
  let viewerEl: HTMLDivElement | undefined;

  /** Point the viewer at an instance: clear the buffer, seed from the
   *  persisted log file, and update the header. Live event lines append on
   *  top of the seed. */
  const loadInstance = async (target: LogTarget) => {
    setInstanceId(target.instance_id);
    setInstanceName(target.name);
    try {
      const content = await readInstanceLog(target.instance_id);
      // Split into lines, dropping a single trailing empty line from the
      // file's final newline so we don't render a phantom blank row.
      const split = content.length ? content.split(/\r?\n/) : [];
      if (split.length && split[split.length - 1] === "") split.pop();
      setLines(split.length > MAX_LINES ? split.slice(split.length - MAX_LINES) : split);
    } catch {
      setLines([]);
    }
  };

  onMount(async () => {
    try {
      const target = await currentLogTarget();
      if (target) await loadInstance(target);
    } catch { /* no target yet — wait for an event */ }

    // Tail live output for the active instance. The event is broadcast to all
    // windows, so we filter by the instance this popout is showing.
    const unlistenLog = await listen<{ instanceId: string; line: string }>("game-log", (e) => {
      if (e.payload.instanceId && e.payload.instanceId === instanceId()) {
        setLines((prev) => {
          const next = [...prev, e.payload.line];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      }
    });

    // Re-point at a different instance when one launches while we're open.
    const unlistenSwitch = await listen<LogTarget>("logs-load-instance", (e) => {
      loadInstance(e.payload);
    });

    onCleanup(() => {
      unlistenLog();
      unlistenSwitch();
    });
  });

  const toggleFilter = (filter: string) => {
    const current = new Set(filters());
    if (filter === "all") {
      setFilters(new Set(["all"]));
      return;
    }
    current.delete("all");
    if (current.has(filter)) {
      current.delete(filter);
    } else {
      current.add(filter);
    }
    if (current.size === 0) current.add("all");
    setFilters(current);
  };

  const filteredLines = () => {
    const active = filters();
    const q = search().trim().toLowerCase();
    let out = lines();
    if (!active.has("all")) {
      out = out.filter((l) => {
        if (active.has("error") && (l.includes("ERROR") || l.includes("FATAL"))) return true;
        if (active.has("warn") && (l.includes("WARN") || l.includes("WARNING"))) return true;
        return false;
      });
    }
    if (q) out = out.filter((l) => l.toLowerCase().includes(q));
    return out;
  };

  const jumpToTop = () => {
    setAutoScroll(false);
    viewerEl?.scrollTo({ top: 0, behavior: "smooth" });
  };
  const jumpToBottom = () => {
    setAutoScroll(true);
    if (viewerEl) viewerEl.scrollTo({ top: viewerEl.scrollHeight, behavior: "smooth" });
  };

  return (
    <div class="logs-popout">
      {/* Custom titlebar to match the launcher chrome (window is undecorated).
          Mirrors components/Titlebar.tsx controls; drag region fills the bar. */}
      <div class="titlebar" onMouseDown={() => appWindow.startDragging()}>
        <div class="win-btns">
          <button class="win-btn win-close" onClick={(e) => { e.stopPropagation(); appWindow.close(); }} onMouseDown={(e) => e.stopPropagation()}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" /><line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
            </svg>
          </button>
          <button class="win-btn win-minimize" onClick={(e) => { e.stopPropagation(); appWindow.minimize(); }} onMouseDown={(e) => e.stopPropagation()}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="2.5" y1="6" x2="9.5" y2="6" />
            </svg>
          </button>
          <button class="win-btn win-maximize" onClick={(e) => { e.stopPropagation(); appWindow.toggleMaximize(); }} onMouseDown={(e) => e.stopPropagation()}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
            </svg>
          </button>
        </div>
        <div class="titlebar-title">Logs{instanceName() ? ` — ${instanceName()}` : ""}</div>
      </div>

      <div class="logs-popout-body">
        <div class="log-toolbar">
        <div class="log-toolbar-filters">
          <div class={`log-filter-btn ${filters().has("all") ? "active" : ""}`} onClick={() => toggleFilter("all")}>All</div>
          <div class={`log-filter-btn error ${filters().has("error") ? "active" : ""}`} onClick={() => toggleFilter("error")}>Errors</div>
          <div class={`log-filter-btn warn ${filters().has("warn") ? "active" : ""}`} onClick={() => toggleFilter("warn")}>Warnings</div>
        </div>

        <div class="log-toolbar-search">
          <span class="log-toolbar-search-icon"><IconSearch /></span>
          <input
            class="log-toolbar-search-input"
            type="text"
            spellcheck={false}
            placeholder="Search logs..."
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <Show when={search()}>
            <button class="log-toolbar-search-clear" onClick={() => setSearch("")} title="Clear search">
              <span class="side-icon"><IconX /></span>
            </button>
          </Show>
        </div>

        <button class="log-toolbar-jump" onClick={jumpToTop} title="Jump to top">
          <IconArrowUp />
        </button>
        <button class="log-toolbar-jump" onClick={jumpToBottom} title="Jump to latest">
          <IconArrowDown />
        </button>
        <span class="log-toolbar-count">{filteredLines().length} lines</span>
      </div>

      <div
        class="log-viewer-frame"
        ref={(el) => {
          const scroller = el.querySelector<HTMLDivElement>(".log-viewer");
          if (!scroller) return;
          viewerEl = scroller;
          const onScroll = () => {
            const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
            setAutoScroll(atBottom);
          };
          scroller.addEventListener("scroll", onScroll, { passive: true });
          const observer = new MutationObserver(() => {
            if (autoScroll()) scroller.scrollTop = scroller.scrollHeight;
          });
          observer.observe(scroller, { childList: true });
          scroller.scrollTop = scroller.scrollHeight;
        }}
      >
        <div class="log-viewer">
          <Show when={filteredLines().length === 0}>
            <div class="log-empty-hint">
              <Show
                when={search()}
                fallback={<span>No logs yet. Output will appear here while the game runs.</span>}
              >
                <span>No matches for "{search()}".</span>
              </Show>
            </div>
          </Show>
          <For each={filteredLines()}>
            {(line) => (
              <div class={`log-line ${line.includes("ERROR") || line.includes("FATAL") ? "log-error" : (line.includes("WARN") || line.includes("WARNING")) ? "log-warn" : ""}`}>
                {line}
              </div>
            )}
          </For>
        </div>
      </div>
      </div>
    </div>
  );
};

export default LogsPopout;
