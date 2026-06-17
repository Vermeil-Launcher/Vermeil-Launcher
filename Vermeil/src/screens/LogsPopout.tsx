import { Component, createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";
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
      setLines(split);
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
        setLines((prev) => [...prev, e.payload.line]);
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
      <div class="logs-popout-header">
        <span class="logs-popout-title">Logs</span>
        <Show when={instanceName()}>
          <span class="logs-popout-instance">{instanceName()}</span>
        </Show>
      </div>

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
  );
};

export default LogsPopout;
