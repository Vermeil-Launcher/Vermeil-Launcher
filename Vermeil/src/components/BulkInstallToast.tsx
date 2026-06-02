import { Component, Show } from "solid-js";
import { isBulkInstall, bulkDone, bulkProgress, activeDownloadCount } from "../App";

/**
 * Floating progress toast for bulk content installs. Reads live counters from
 * the App-level download state and renders only while a bulk batch is active.
 *
 * Single-item installs use the existing `showToast` notification on success;
 * this toast only appears for batches > 1.
 */
const BulkInstallToast: Component = () => {
  return (
    <Show when={isBulkInstall()}>
      <div class="bulk-toast">
        <div class="bulk-toast-header">
          <span class="bulk-toast-title">Installing content</span>
          <span class="bulk-toast-count">{bulkDone()} of {bulkDone() + activeDownloadCount()}</span>
        </div>
        <div class="bulk-toast-bar-track">
          <div
            class="bulk-toast-bar-fill"
            style={{ width: `${Math.min(bulkProgress() * 100, 100)}%` }}
          />
        </div>
      </div>
    </Show>
  );
};

export default BulkInstallToast;
