import { Component, createResource, createSignal, For, Show } from "solid-js";
import {
  listInstances,
  getInstanceCape,
  setInstanceCape,
  clearInstanceCape,
  readCustomCapeSource,
  Instance,
  CustomCape,
  InstanceCapeState,
} from "../ipc/commands";
import { showToast } from "../App";
import { IconX, IconCheck } from "../components/Icons";
import { FrameSource, bakeModCapeStrip, clampRes, ModCapeBake } from "../lib/cape";

interface Props {
  cape: CustomCape;
  onClose: () => void;
}

interface Row {
  inst: Instance;
  state: InstanceCapeState | null;
}

/**
 * Apply a local custom cape to instances for in-game display.
 *
 * Unlike a Mojang cape, a custom in-game cape is drawn by the Vermeil companion
 * mod, which is per-instance — so this writes the baked cape into each chosen
 * instance and only renders where the mod is installed. The cape is baked once
 * (into the mod's 64×64 frame-strip layout) and reused across instances.
 */
const InGameCapeModal: Component<Props> = (props) => {
  const [rows, { refetch }] = createResource<Row[]>(async () => {
    const insts = await listInstances();
    return Promise.all(
      insts.map(async (inst) => ({
        inst,
        state: await getInstanceCape(inst.id).catch(() => null),
      })),
    );
  });
  const [busy, setBusy] = createSignal<string | null>(null);

  // Bake lazily and once — the cape is identical for every instance.
  let baked: ModCapeBake | null = null;
  const bakeOnce = async (): Promise<ModCapeBake> => {
    if (baked) return baked;
    const sourceUrl = await readCustomCapeSource(props.cape.id);
    const src = await FrameSource.load(sourceUrl);
    try {
      const t = props.cape.transform;
      // Cap animated strips to a sane resolution so a high-res GIF doesn't
      // produce a huge multi-frame PNG; static capes keep their full detail.
      const res =
        src.frameCount > 1 ? Math.min(clampRes(t.res), 8) : clampRes(t.res);
      baked = bakeModCapeStrip(src, {
        dx: t.dx,
        dy: t.dy,
        scale: t.scale,
        bg: t.bg,
        res,
      });
    } finally {
      src.dispose();
    }
    return baked;
  };

  /** Whether this exact cape is applied and enabled on the instance. */
  const isOn = (row: Row): boolean =>
    !!row.state && row.state.cape_id === props.cape.id && row.state.enabled;

  /** Whether a different cape is currently applied to the instance. */
  const hasOther = (row: Row): boolean =>
    !!row.state && row.state.cape_id !== props.cape.id;

  const apply = async (inst: Instance) => {
    setBusy(inst.id);
    try {
      const b = await bakeOnce();
      await setInstanceCape(
        inst.id,
        props.cape.id,
        Array.from(b.png),
        b.frames > 1 ? b.frameTimeMs : null,
        true,
      );
      showToast({ title: "Cape applied in-game", message: inst.name, type: "success" });
      await refetch();
    } catch (e) {
      showToast({ title: "Couldn't apply cape", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (inst: Instance) => {
    setBusy(inst.id);
    try {
      await clearInstanceCape(inst.id);
      await refetch();
    } catch (e) {
      showToast({ title: "Couldn't remove cape", message: String(e), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="modal-overlay">
      <div class="modal panel panel--bracketed" style="width:460px">
        <div class="modal-header">
          <span class="modal-title">Show "{props.cape.name}" in-game</span>
          <button class="modal-close" onClick={props.onClose}><IconX /></button>
        </div>

        <div class="modal-body">
          <p class="ingame-cape-note">
            In-game capes are rendered by the Vermeil companion mod and apply per
            instance — they show only on instances that have the mod installed.
          </p>

          <Show
            when={(rows() ?? []).length > 0}
            fallback={<p class="ingame-cape-empty">No instances yet. Create one first.</p>}
          >
            <div class="ingame-cape-list">
              <For each={rows()}>
                {(row) => (
                  <div class="ingame-cape-row">
                    <div class="ingame-cape-row-info">
                      <span class="ingame-cape-row-name">{row.inst.name}</span>
                      <span class="ingame-cape-row-meta">
                        {row.inst.game_version}
                        {row.inst.loader.type !== "vanilla" ? ` • ${row.inst.loader.type}` : ""}
                        {hasOther(row) ? " • another cape applied" : ""}
                      </span>
                    </div>
                    <Show
                      when={isOn(row)}
                      fallback={
                        <button
                          class="install-btn ingame-cape-toggle"
                          onClick={() => apply(row.inst)}
                          disabled={busy() !== null}
                        >
                          {busy() === row.inst.id ? "Applying…" : "Show in-game"}
                        </button>
                      }
                    >
                      <button
                        class="btn ingame-cape-toggle ingame-cape-toggle--on"
                        onClick={() => remove(row.inst)}
                        disabled={busy() !== null}
                        title="Remove from this instance"
                      >
                        <IconCheck />
                        <span>In-game</span>
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="modal-footer">
          <button class="btn btn--ghost" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
};

export default InGameCapeModal;
