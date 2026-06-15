import { Component } from "solid-js";
import { setActiveScreen } from "../App";
import { IconLayers, IconSettings, IconDownload } from "../components/Icons";

const CreateChoose: Component = () => {
  return (
    <div class="modal-overlay">
      <div class="modal panel panel--bracketed">
        <div class="modal-header">
          <span class="modal-title">Create instance</span>
          <button class="modal-close" onClick={() => setActiveScreen("library")}>✕</button>
        </div>
        <div class="modal-body">
          <div class="create-choice-grid">
            <div class="create-choice-card green" onClick={() => setActiveScreen("create-custom")}>
              <div class="create-choice-icon" style="color:var(--accent)"><IconSettings /></div>
              <div class="create-choice-text">
                <div class="create-choice-title">Custom setup</div>
                <div class="create-choice-desc">Pick your loader, version, and configure everything manually</div>
              </div>
            </div>
            <div class="create-choice-card blue" onClick={() => setActiveScreen("create-modpack")}>
              <div class="create-choice-icon" style="color:var(--blue)"><IconLayers /></div>
              <div class="create-choice-text">
                <div class="create-choice-title">Install modpack</div>
                <div class="create-choice-desc">Browse and install a modpack from Modrinth</div>
              </div>
            </div>
            <div class="create-choice-card orange" onClick={() => setActiveScreen("create-import")}>
              <div class="create-choice-icon" style="color:var(--orange)"><IconDownload /></div>
              <div class="create-choice-text">
                <div class="create-choice-title">Import</div>
                <div class="create-choice-desc">Import from CurseForge (.zip export or profile code)</div>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn--ghost" onClick={() => setActiveScreen("library")}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

export default CreateChoose;
