import { Component, Show } from "solid-js";
import { setActiveScreen } from "../App";
import { IconX } from "./Icons";

const NoAccountModal: Component<{ open: boolean; onClose: () => void }> = (props) => {
  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={props.onClose}>
        <div class="modal panel panel--bracketed" style="max-width:400px" onClick={(e) => e.stopPropagation()}>
          <div class="modal-header">
            <span class="modal-title">Account required</span>
            <button class="modal-close" onClick={props.onClose}><IconX /></button>
          </div>
          <div class="modal-body">
            <div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:12px">
              You need to add an account before you can launch Minecraft.
            </div>
            <div style="font-size:11px;color:var(--muted);line-height:1.5">
              Sign in with Microsoft to play on online servers, or create an offline account to play singleplayer and on offline servers.
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn--ghost" onClick={props.onClose}>Cancel</button>
            <button class="btn btn--primary" onClick={() => { props.onClose(); setActiveScreen("account"); }}>
              Go to Account
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default NoAccountModal;
