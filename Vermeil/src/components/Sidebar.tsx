import { Component, For, Show } from "solid-js";
import {
  activeScreen,
  setActiveScreen,
  Screen,
  instances,
  pinnedInstanceIds,
  setActiveInstanceId,
  setInitialInstanceTab,
  activeInstanceId,
} from "../App";
import {
  IconHome,
  IconGrid,
  IconDownload,
  IconSettings,
  IconUser,
  IconShirt,
  IconPlus,
} from "./Icons";
import { openPinInstancesModal } from "../modals/PinInstancesModal";

const MAX_PINS = 3;

/** Map a loader type to the CSS modifier that tints the pinned-icon tile.
 *  Mirrors `bannerColor()` over in Library.tsx so a pin and its instance
 *  card read as the same thing visually. */
function pinLoaderClass(loader: string): string {
  switch (loader) {
    case "fabric": return "loader-fabric";
    case "quilt": return "loader-quilt";
    case "forge": return "loader-forge";
    case "neoforge": return "loader-neoforge";
    default: return "loader-vanilla";
  }
}

const Sidebar: Component = () => {
  const isActive = (screens: Screen[]) => screens.includes(activeScreen());

  const NavIcon = (props: { screens: Screen[]; target: Screen; icon: any; label: string }) => (
    <div
      class={`nav-icon ${isActive(props.screens) ? "active" : ""}`}
      onClick={() => setActiveScreen(props.target)}
      data-tooltip={props.label}
    >
      {props.icon}
    </div>
  );

  // Resolve pinned IDs against the live instances list. Filters out any
  // pinned IDs that no longer exist (instance was deleted) so we never
  // render a broken shortcut.
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
  };

  return (
    <div class="sidebar">
      <div class="sidebar-logo" title="Vermeil">
        <img src="/logo.png" alt="Vermeil" draggable={false} />
      </div>
      <NavIcon screens={["home"]} target="home" icon={<IconHome />} label="Home" />
      <NavIcon
        screens={["library", "mods", "create-choose", "create-custom", "create-modpack"]}
        target="library"
        icon={<IconGrid />}
        label="Library"
      />
      <NavIcon screens={["skins"]} target="skins" icon={<IconShirt />} label="Skins" />

      <div class="nav-sep" />

      {/* Pinned instance shortcuts. Each tile shows the first letter of the
          instance name, tinted by its loader, and jumps straight to the
          instance's content tab when clicked. The active state lights up
          the tile when the user is currently viewing that instance. */}
      <For each={pinnedInstances()}>
        {(inst) => {
          const isViewing = () =>
            activeScreen() === "mods" && activeInstanceId() === inst.id;
          const iconSrc = () =>
            inst.icon && inst.icon !== "cube" ? inst.icon : undefined;
          return (
            <div
              class={`nav-pin-icon ${pinLoaderClass(inst.loader.type)} ${isViewing() ? "active" : ""}`}
              onClick={() => openPinned(inst.id)}
              data-tooltip={inst.name}
            >
              <Show
                when={iconSrc()}
                fallback={inst.name.trim().charAt(0).toUpperCase() || "?"}
              >
                <img
                  src={iconSrc()!}
                  alt=""
                  draggable={false}
                  class="nav-pin-icon-img"
                />
              </Show>
            </div>
          );
        }}
      </For>

      {/* Manage-pins button. Always shows the plus icon. When the user has
          hit the 3-pin limit, hover morphs the plus into a minus via a CSS
          transform on the vertical bar of the SVG — single icon, animated,
          rather than swapping between two icons. The morph hints that this
          re-opens the picker (where the user can deselect to free a slot)
          rather than feeling like the button "doesn't work" at the limit. */}
      <div
        class="nav-icon nav-pin-toggle"
        onClick={openPinInstancesModal}
        data-tooltip={
          pinnedInstanceIds().length >= MAX_PINS
            ? "Pin limit reached — manage pins"
            : pinnedInstanceIds().length > 0
              ? "Manage pinned instances"
              : "Pin an instance to the sidebar"
        }
      >
        <IconPlus />
      </div>

      {/* Bottom rail — Downloads, Settings, Account. Downloads moved here
          from above so it sits with the other utility shortcuts and frees
          its old slot for the pin manager. */}
      <div class="nav-bottom">
        <NavIcon screens={["downloads"]} target="downloads" icon={<IconDownload />} label="Downloads" />
        <NavIcon screens={["settings"]} target="settings" icon={<IconSettings />} label="Settings" />
        <NavIcon screens={["account"]} target="account" icon={<IconUser />} label="Account" />
      </div>
    </div>
  );
};

export default Sidebar;
