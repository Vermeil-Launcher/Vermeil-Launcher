import { Component, createSignal, createResource, createEffect, Show, For } from "solid-js";
import { account, activeSkinUrl, refetchAccount } from "../App";
import {
  startMsLogin,
  addOfflineAccount,
  getAllAccounts,
  setActiveAccount,
  removeAccount,
  getAccountSkin,
} from "../ipc/commands";
import PlayerHead from "../components/PlayerHead";
import { IconX } from "../components/Icons";
import type { MinecraftProfile } from "../ipc/commands";

/**
 * Cache of skin data URLs per account ID, keyed by Microsoft account UUID.
 * Lives at module scope so re-renders don't blow it away. Each entry is
 * fetched lazily on first render and reused thereafter — without this,
 * switching the active account would clear all the inactive accounts' skin
 * heads back to the colored-initial fallback.
 */
const [skinCache, setSkinCache] = createSignal<Record<string, string>>({});

/** Force-refresh a specific account's cached skin, e.g. after a skin upload. */
export function invalidateAccountSkin(accountId: string) {
  setSkinCache(prev => {
    const next = { ...prev };
    delete next[accountId];
    return next;
  });
}

const Account: Component = () => {
  const [loggingIn, setLoggingIn] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [offlineUsername, setOfflineUsername] = createSignal("");
  const [accounts, { refetch: refetchAccounts }] = createResource(getAllAccounts);

  // Whenever the account list changes, fetch skin heads for every Microsoft
  // account we don't already have cached. The active account's skin also
  // gets routed through the global `activeSkinUrl` signal — but that one
  // doesn't include the *other* signed-in Microsoft accounts, which is what
  // this loop fills in.
  createEffect(() => {
    const list = accounts();
    if (!list) return;
    for (const acc of list) {
      if (acc.is_offline) continue;
      if (skinCache()[acc.id]) continue; // already cached
      // Fire-and-forget — failures (network, 401, etc.) just leave the row
      // showing the colored-initial fallback, which is fine.
      getAccountSkin(acc.id)
        .then((url) => {
          if (url) {
            setSkinCache(prev => ({ ...prev, [acc.id]: url }));
          }
        })
        .catch(() => {
          /* leave fallback in place */
        });
    }
  });

  // The active account's skin is already kept fresh via `activeSkinUrl` in
  // App.tsx. Mirror it into the per-account cache so the row picks it up
  // without an extra IPC round-trip.
  createEffect(() => {
    const activeUrl = activeSkinUrl();
    const a = account();
    if (activeUrl && a && !a.is_offline) {
      setSkinCache(prev => ({ ...prev, [a.id]: activeUrl }));
    }
  });

  const handleLogin = async () => {
    setLoggingIn(true);
    setError(null);
    try {
      await startMsLogin();
      await refetchAccount();
      await refetchAccounts();
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e.message || "Login failed";
      if (msg !== "Login cancelled") {
        setError(msg);
      }
    } finally {
      setLoggingIn(false);
    }
  };

  const handleOfflineLogin = async () => {
    const name = offlineUsername().trim();
    if (!name) return;
    setError(null);
    try {
      await addOfflineAccount(name);
      await refetchAccount();
      await refetchAccounts();
      setOfflineUsername("");
    } catch (e: any) {
      setError(typeof e === "string" ? e : e.message || "Failed to add account");
    }
  };

  const handleSwitch = async (id: string) => {
    await setActiveAccount(id);
    await refetchAccount();
    await refetchAccounts();
  };

  const handleRemove = async (id: string) => {
    await removeAccount(id);
    await refetchAccount();
    await refetchAccounts();
    // Drop any cached skin for the removed account.
    setSkinCache(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const skinFor = (acc: MinecraftProfile): string | null => {
    if (acc.is_offline) return null;
    return skinCache()[acc.id] ?? null;
  };

  return (
    <div class="screen-enter">
      <div class="section-label">Accounts</div>

      {/* Account grid — two columns at any reasonable window width, one
          column when the launcher is dragged narrow. Wider cards leave room
          for the head, name, type, badge, and the remove button without
          crowding. */}
      <Show when={accounts() && accounts()!.length > 0}>
        <div class="account-grid">
          <For each={accounts()}>
            {(acc: MinecraftProfile) => (
              <div
                class={`account-card ${acc.active ? "active" : ""}`}
                onClick={() => !acc.active && handleSwitch(acc.id)}
              >
                <div class="account-card-avatar">
                  <PlayerHead
                    skinUrl={skinFor(acc)}
                    name={acc.name}
                    size={48}
                  />
                </div>
                <div class="account-card-info">
                  <div class="account-card-name">{acc.name}</div>
                  <div class="account-card-type">
                    {acc.is_offline ? "Offline" : "Microsoft"}
                  </div>
                </div>
                <Show when={acc.active}>
                  <span class="account-badge-active">Active</span>
                </Show>
                <button
                  class="account-card-remove"
                  onClick={(e) => { e.stopPropagation(); handleRemove(acc.id); }}
                  title="Remove account"
                >
                  <IconX />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Add account section */}
      <div style="margin-top:20px">
        <div class="section-label">Add account</div>

        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
          <button
            class="btn btn--primary"
            onClick={handleLogin}
            disabled={loggingIn()}
          >
            {loggingIn() ? "Signing in..." : "+ Microsoft"}
          </button>
        </div>

        <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
          Or add an offline account:
        </div>
        <div style="display:flex;gap:8px">
          <input
            class="field-control field-control--text"
            placeholder="Username (1-16 chars)"
            style="max-width:220px"
            value={offlineUsername()}
            onInput={(e) => setOfflineUsername(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleOfflineLogin(); }}
            maxLength={16}
          />
          <button class="btn" onClick={handleOfflineLogin} disabled={!offlineUsername().trim()}>
            + Offline
          </button>
        </div>
      </div>

      <Show when={error()}>
        <div style="color:var(--danger);font-size:11px;margin-top:12px;padding:8px 10px;background:var(--danger-soft);border:1px solid var(--danger)">
          {error()}
        </div>
      </Show>

      <div style="font-size:10px;color:var(--muted);margin-top:20px;line-height:1.5">
        Vermeil is unofficial. Not affiliated with Mojang Studios or Microsoft.
        Authentication uses Microsoft's official OAuth flow.
        Tokens are stored locally only — Vermeil has no servers.
      </div>
    </div>
  );
};

export default Account;
