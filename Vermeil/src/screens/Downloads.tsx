import { Component, For, Show } from "solid-js";
import { downloads, clearDownloadHistory, DownloadEntry } from "../App";
import { IconCheck, IconX } from "../components/Icons";

function getCategoryLabel(category: string): string {
  switch (category) {
    case "mod": return "Mod";
    case "resourcepack": return "Resource Pack";
    case "shader": return "Shader";
    case "datapack": return "Datapack";
    case "modpack": return "Modpack";
    default: return "Download";
  }
}

const Downloads: Component = () => {
  const history = () => downloads().filter(d => d.status !== "downloading").slice(0, 100);

  const timeAgo = (ts: number): string => {
    const diff = Date.now() - ts;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <div class="screen-enter">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="section-label">Download History</div>
        <Show when={history().length > 0}>
          <button class="btn btn--sm" onClick={clearDownloadHistory}>Clear</button>
        </Show>
      </div>
      <Show when={history().length > 0} fallback={
        <div style="color:var(--muted);font-size:12px;padding:14px;background:var(--bg3);border:1px solid var(--border);text-align:center">
          Download history will appear here.
        </div>
      }>
        <div class="card-grid" style="margin-bottom:16px">
          <For each={history()}>
            {(dl) => <DownloadCard entry={dl} timeAgo={timeAgo} />}
          </For>
        </div>
      </Show>
    </div>
  );
};

/** Individual download history card with icon, metadata pills, and status. */
const DownloadCard: Component<{ entry: DownloadEntry; timeAgo: (ts: number) => string }> = (props) => {
  const dl = () => props.entry;
  const failed = () => dl().status === "failed";

  return (
    <div class="card card--inst" classList={{ "dl-card-failed": failed() }}>
      <div class="card-body">
        <div class="dl-card-icon">
          <Show when={dl().iconUrl} fallback={
            <span class="dl-card-icon-fallback">{dl().name.charAt(0).toUpperCase()}</span>
          }>
            <img src={dl().iconUrl!} alt="" draggable={false} />
          </Show>
        </div>
        <div class="dl-card-body">
          <div class="dl-card-header">
            <span class="dl-card-name">{dl().name}</span>
            <Show when={dl().author}>
              <span class="dl-card-author">by {dl().author}</span>
            </Show>
            <span class={`dl-card-status side-icon ${failed() ? "failed" : "success"}`}>
              {failed() ? <IconX /> : <IconCheck />}
            </span>
          </div>
          <div class="dl-card-meta">
            <span class="badge">{getCategoryLabel(dl().category)}</span>
            <Show when={dl().loader}>
              <span class={`badge badge--loader badge--${dl().loader}`}>{dl().loader}</span>
            </Show>
            <Show when={dl().gameVersion}>
              <span class="badge badge--version">{dl().gameVersion}</span>
            </Show>
            <Show when={dl().versionNumber}>
              <span class="badge badge--vnum" title={dl().versionNumber!}>{dl().versionNumber}</span>
            </Show>
            <span class="dl-card-time">{props.timeAgo(dl().timestamp)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Downloads;
