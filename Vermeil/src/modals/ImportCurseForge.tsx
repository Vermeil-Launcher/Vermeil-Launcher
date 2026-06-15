import { Component, createSignal, Show } from "solid-js";
import { setActiveScreen, refetchInstances, showToast, trackDownload, completeDownload, failDownload } from "../App";
import { importCfZip } from "../ipc/commands";
import { open } from "@tauri-apps/plugin-dialog";

const ImportCurseForge: Component = () => {
  const [importing, setImporting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleImportZip = async () => {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "CurseForge Export", extensions: ["zip"] }],
      });
      if (!selected) return;

      // Close the modal and navigate to library immediately. Backend emits
      // install-progress events handled by <InstallProgress />.
      setActiveScreen("library");
      setImporting(true);

      const fileName = (selected as string).split(/[\\/]/).pop() || "CurseForge pack";
      const dlId = trackDownload(fileName.replace(/\.zip$/i, ""), "modpack");

      importCfZip(selected as string)
        .then((instance) => {
          refetchInstances();
          completeDownload(dlId, instance.name);
          showToast({ title: "Import complete", message: `${instance.name} imported successfully`, type: "success" });
        })
        .catch((e: any) => {
          failDownload(dlId);
          showToast({
            title: "Import failed",
            message: typeof e === "string" ? e : e.message || "Import failed",
            type: "error",
            autoCloseMs: 6000,
          });
        })
        .finally(() => setImporting(false));
    } catch (e: any) {
      setError(typeof e === "string" ? e : e.message || "Import failed");
      setImporting(false);
    }
  };

  return (
    <div class="modal-overlay">
      <div class="modal panel panel--bracketed">
        <div class="modal-header">
          <span class="modal-title">Import from CurseForge</span>
          <button class="modal-close" onClick={() => setActiveScreen("library")}>✕</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <div class="field-label">Import .zip export</div>
            <div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5">
              In the CurseForge app: select your profile → three dots → Share Profile → Export as .zip.
              Then import that file here.
            </div>
            <button
              class="btn btn--primary"
              style="padding:10px 18px"
              onClick={handleImportZip}
              disabled={importing()}
            >
              {importing() ? "Importing..." : "Choose .zip file"}
            </button>
          </div>

          <Show when={error()}>
            <div style="color:#e05252;font-size:11px;margin-top:12px;padding:8px 10px;background:#1a1214;border:1px solid #3a1a1a">
              {error()}
            </div>
          </Show>
        </div>
        <div class="modal-footer">
          <button class="btn btn--ghost" onClick={() => setActiveScreen("create-choose")}>
            ← Back
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportCurseForge;
