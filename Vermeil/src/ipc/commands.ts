import { invoke } from "@tauri-apps/api/core";

// App commands
export const showWindow = () => invoke<void>("show_window");

// Types
export interface Instance {
  id: string;
  name: string;
  icon: string;
  game_version: string;
  loader: { type: string; version: string | null };
  java: { memory_max_mb: number };
  window: { width: number; height: number; fullscreen: boolean };
  mods: any[];
  last_played: string | null;
  total_play_seconds: number;
  created_at: string;
  source_project_id: string | null;
}

export interface CreateInstanceConfig {
  name: string;
  game_version: string;
  loader_type: string;
  loader_version: string | null;
  icon: string | null;
  memory_max_mb: number | null;
}

export interface GameVersion {
  id: string;
  version_type: string;
  release_time: string;
}

export interface FabricVersion {
  version: string;
  stable: boolean;
}

export interface ModHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  follows: number;
  client_side: string | null;
  server_side: string | null;
  categories: string[];
  /** Game versions this project supports (Modrinth's `versions[]` field). */
  versions?: string[];
  /** Latest version ID (Modrinth's `latest_version`). */
  latest_version?: string | null;
  /** Primary author display name. Modrinth: search hit's `author`.
   *  CurseForge: first entry of the project's `authors[]` array. */
  author?: string | null;
}

export interface ModSearchResult {
  hits: ModHit[];
  total_hits: number;
  offset: number;
  limit: number;
}

export interface MinecraftProfile {
  id: string;
  name: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  is_offline: boolean;
  skin_path: string | null;
  active: boolean;
}

export interface LauncherSettings {
  java_runtime: string;
  default_memory_mb: number;
  gc_preset: string;
  close_on_launch: boolean;
  auto_update: boolean;
  discord_rpc: boolean;
  show_snapshots: boolean;
  concurrent_downloads: number;
  /**
   * Maximum simultaneous disk writes during batch downloads.
   * Separated from network concurrency so a slow disk doesn't starve
   * fetches and vice versa.
   */
  concurrent_writes: number;
  mod_sources: string[];
  force_delete: boolean;
  curseforge_api_key: string;
  /**
   * Whether the user has completed the first-run onboarding wizard. The
   * wizard runs once for any user whose `onboarded` is `false` and who has
   * no instances yet, then flips this to `true` so it never reappears.
   */
  onboarded: boolean;
  /**
   * User-selected Java executable per major version. Populated by Settings →
   * Resources → Java when the user chooses Install / Detect / Browse. Maps
   * major version (8, 17, 21, 25) → absolute path to `java(.exe)`. Empty
   * means the launcher falls back to auto-detection / auto-install.
   */
  java_paths: Record<number, string>;
  /**
   * Instance IDs pinned to the sidebar as quick-launch shortcuts. Capped
   * at 3 by the UI. The sidebar renders one icon per pinned instance
   * between Skins and the manage-pins button.
   */
  sidebar_pinned_instances: string[];
  /**
   * Global video settings applied to every instance's options.txt before launch.
   * When a field is null, that setting is left untouched.
   */
  video_settings: {
    max_fps: number | null;
    vsync: boolean | null;
    view_bobbing: boolean | null;
    gui_scale: number | null;
    fov: number | null;
    fov_effects: number | null;
    master_volume: number | null;
    music_volume: number | null;
    window_width: number | null;
    window_height: number | null;
    fullscreen: boolean | null;
    start_maximized: boolean | null;
  };
  /**
   * User-customizable keyboard shortcuts. Map of action ID → key combo
   * (e.g. "Ctrl+P"). The action registry lives in `src/lib/keybinds.ts`;
   * missing entries fall back to that file's hardcoded defaults.
   */
  keybinds: Record<string, string>;
}

// Instance commands
export const listInstances = () => invoke<Instance[]>("list_instances");
export const createInstance = (config: CreateInstanceConfig) => invoke<Instance>("create_instance", { config });
export const prepareInstance = (id: string) => invoke<void>("prepare_instance", { id });
export const getInstance = (id: string) => invoke<Instance>("get_instance", { id });
export const deleteInstance = (id: string) => invoke<void>("delete_instance", { id });
export const updateInstanceMemory = (id: string, memoryMaxMb: number) => invoke<void>("update_instance_memory", { id, memoryMaxMb });
export const updateInstanceOptions = (id: string, opts: { memoryMaxMb?: number; width?: number; height?: number; fullscreen?: boolean; extraArgs?: string[] }) =>
  invoke<void>("update_instance_options", { id, ...opts });
export const renameInstance = (id: string, newName: string) => invoke<void>("rename_instance", { id, newName });
export const setInstanceIcon = (id: string, sourcePath: string) =>
  invoke<string>("set_instance_icon", { id, sourcePath });
export const clearInstanceIcon = (id: string) => invoke<void>("clear_instance_icon", { id });
export const cloneInstance = (id: string, newName?: string) =>
  invoke<Instance>("clone_instance", { id, newName });
export const installModpack = (projectId: string, versionId?: string) => invoke<Instance>("install_modpack", { projectId, versionId });
export const installCfModpack = (projectId: string, fileId?: string) => invoke<Instance>("install_cf_modpack", { projectId, fileId });
export const importCfZip = (zipPath: string) => invoke<Instance>("import_cf_zip", { zipPath });
export const importCfCode = (code: string) => invoke<Instance>("import_cf_code", { code });

// Meta commands
export const getGameVersions = (includeSnapshots: boolean) =>
  invoke<GameVersion[]>("get_game_versions", { includeSnapshots });
export const getFabricLoaderVersions = () => invoke<FabricVersion[]>("get_fabric_loader_versions");
export const getFabricGameVersions = () => invoke<string[]>("get_fabric_game_versions");
export const getQuiltLoaderVersions = () => invoke<FabricVersion[]>("get_quilt_loader_versions");
export const getNeoforgeVersions = (gameVersion: string) => invoke<FabricVersion[]>("get_neoforge_versions", { gameVersion });
export const getNeoforgeGameVersions = () => invoke<string[]>("get_neoforge_game_versions");
export const getForgeVersions = (gameVersion: string) => invoke<FabricVersion[]>("get_forge_versions", { gameVersion });
export const getForgeGameVersions = () => invoke<string[]>("get_forge_game_versions");
export const getQuiltGameVersions = () => invoke<string[]>("get_quilt_game_versions");

export interface NewsArticle {
  title: string;
  version: string;
  image_url: string;
  url: string;
  body: string;
}
export const getJavaNews = () => invoke<NewsArticle[]>("get_java_news");
export const getArticleBody = (contentUrl: string) => invoke<string>("get_article_body", { contentUrl });

// Mod commands
export const searchMods = (query: string, loader: string, gameVersion: string, offset?: number, limit?: number, sort?: string, projectType?: string) =>
  invoke<ModSearchResult>("search_mods", { query, loader, gameVersion, offset, limit, sort, projectType });
export const searchModpacks = (query: string, offset?: number, sort?: string, loader?: string) =>
  invoke<ModSearchResult>("search_modpacks", { query, offset, sort, loader });

export const searchCurseforge = (query: string, loader: string, gameVersion: string, offset?: number, limit?: number, sort?: string, projectType?: string) =>
  invoke<ModSearchResult>("search_curseforge", { query, loader, gameVersion, offset, limit, sort, projectType });

// Auth commands
export const startMsLogin = () => invoke<string>("start_ms_login");
export const getActiveAccount = () => invoke<MinecraftProfile | null>("get_active_account");
export const getAllAccounts = () => invoke<MinecraftProfile[]>("get_all_accounts");
export const setActiveAccount = (id: string) => invoke<void>("set_active_account", { id });
export const addOfflineAccount = (username: string) => invoke<MinecraftProfile>("add_offline_account", { username });
export const setAccountSkin = (skinFilePath: string) => invoke<string>("set_account_skin", { skinFilePath });
export const removeAccount = (id: string) => invoke<void>("remove_account", { id });
export const logout = () => invoke<void>("logout");

// Launch commands
export const launchInstance = (instanceId: string) => invoke<number>("launch_instance", { instanceId });
export const installModToInstance = (instanceId: string, projectId: string, loader: string, gameVersion: string, category?: string) =>
  invoke<string>("install_mod_to_instance", { instanceId, projectId, loader, gameVersion, category });
export const installCfModToInstance = (instanceId: string, modId: string, loader: string, gameVersion: string, category?: string) =>
  invoke<string>("install_cf_mod_to_instance", { instanceId, modId, loader, gameVersion, category });
export const removeModFromInstance = (instanceId: string, entryId: string) =>
  invoke<void>("remove_mod_from_instance", { instanceId, entryId });
export const removeAllContent = (instanceId: string, category: string) =>
  invoke<number>("remove_all_content", { instanceId, category });

/**
 * Available Modrinth update for a single installed mod. Mirrors the backend
 * `ModUpdate` struct so the Installed-tab can decorate each card with an
 * update pill.
 */
export interface ModUpdate {
  project_id: string;
  current_version_id: string;
  latest_version_id: string;
  latest_version_number: string;
  latest_filename: string;
  latest_published: string | null;
}

/** Check every Modrinth-sourced mod in the instance for updates. */
export const checkModUpdates = (instanceId: string) =>
  invoke<Record<string, ModUpdate>>("check_mod_updates", { instanceId });

/** Apply a previously-detected update. Returns the same JSON envelope as
 *  installModToInstance: { mod_entry, deps_installed, dep_titles, issues }. */
export const applyModUpdate = (instanceId: string, projectId: string) =>
  invoke<string>("apply_mod_update", { instanceId, projectId });
export const toggleModInInstance = (instanceId: string, entryId: string) =>
  invoke<boolean>("toggle_mod_in_instance", { instanceId, entryId });
export const stopInstance = () => invoke<void>("stop_instance");
export const minimizeToTray = () => invoke<void>("minimize_to_tray");

// Settings commands
export const getSettings = () => invoke<LauncherSettings>("get_settings");
export const saveSettings = (settings: LauncherSettings) => invoke<void>("save_settings", { settings });
export const getCacheSize = () => invoke<number>("get_cache_size");
export const purgeCache = () => invoke<number>("purge_cache");
export const getSystemMemory = () => invoke<number>("get_system_memory");
export const loadDownloadHistory = () => invoke<string>("load_download_history");
export const saveDownloadHistory = (json: string) => invoke<void>("save_download_history", { json });

/**
 * One installed JRE detected on the system. Mirrors `services::java::JavaInstall`.
 * `source` indicates which discovery path found this install — used by the UI
 * to render a hint badge ("Auto-installed" / "Path" / "Registry" / etc.).
 */
export interface JavaInstall {
  major: number;
  full_version: string;
  arch: string;
  path: string;
  source: "auto_installed" | "bundled" | "env_path" | "common_dir" | "registry" | "manual";
}

// Java location finder commands
export const detectJavaInstallations = () => invoke<JavaInstall[]>("detect_java_installations");
export const validateJavaPath = (path: string) => invoke<JavaInstall>("validate_java_path", { path });
export const setJavaPath = (major: number, path: string | null) =>
  invoke<void>("set_java_path", { major, path });
export const installRecommendedJava = (major: number) =>
  invoke<JavaInstall>("install_recommended_java", { major });

// ─── Skins / capes ───
//
// Match Mojang's wire format — the profile endpoint serializes variant as
// `"CLASSIC"` / `"SLIM"` (uppercase). We mirror that for symmetry between
// inbound (parsed from Mojang) and outbound (sent to our own IPC). Pretty
// strings for display ("Classic" / "Slim") are computed in the UI layer.
//
// `"UNKNOWN"` is the fallback the backend produces when Mojang returns a
// variant we don't recognize. The UI should treat it as "can't equip" and
// surface a hint rather than crashing.
export type SkinVariant = "CLASSIC" | "SLIM" | "UNKNOWN";

export interface RemoteSkin {
  id: string;
  state: string;
  /**
   * `data:image/png;base64,...` URL ready to drop into `<img src>` or
   * skinview3d's `loadSkin`. The backend pre-fetches and inlines the texture
   * so the webview never has to talk to `textures.minecraft.net` directly.
   */
  texture: string;
  variant: SkinVariant;
}
export interface RemoteCape {
  id: string;
  state: string;
  /** Same `data:image/png;` inlining as `RemoteSkin::texture`. */
  texture: string;
  alias: string;
}
export interface PlayerProfile {
  id: string;
  name: string;
  skins: RemoteSkin[];
  capes: RemoteCape[];
}
export interface LocalSkin {
  hash: string;
  name: string;
  variant: SkinVariant;
  /** `data:image/png;base64,...` for the saved skin's bytes. */
  texture: string;
  /** Unix epoch seconds when added. */
  created_at: number;
}

export const getSkinProfile = () => invoke<PlayerProfile>("get_skin_profile");
export const uploadSkin = (
  pngBytes: number[],
  variant: SkinVariant,
  saveToLibrary: boolean,
  libraryName?: string,
) =>
  invoke<PlayerProfile>("upload_skin", {
    pngBytes,
    variant,
    saveToLibrary,
    libraryName,
  });
export const equipLocalSkin = (hash: string) =>
  invoke<PlayerProfile>("equip_local_skin", { hash });
export const resetSkin = () => invoke<PlayerProfile>("reset_skin");
export const equipCape = (capeId: string) =>
  invoke<PlayerProfile>("equip_cape", { capeId });
export const unequipCape = () => invoke<PlayerProfile>("unequip_cape");
export const listLocalSkins = () => invoke<LocalSkin[]>("list_local_skins");
export const addLocalSkin = (name: string, pngBytes: number[], variant: SkinVariant) =>
  invoke<LocalSkin>("add_local_skin", { name, pngBytes, variant });
export const removeLocalSkin = (hash: string) =>
  invoke<void>("remove_local_skin", { hash });

/**
 * Fetch a single account's current skin head (data URL) without changing
 * the active account. Used by the Account screen so every Microsoft row
 * shows its own face. Returns `null` for offline accounts.
 */
export const getAccountSkin = (accountId: string) =>
  invoke<string | null>("get_account_skin", { accountId });

// File/World commands
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string;
}

export interface WorldEntry {
  name: string;
  folder_name: string;
  size_mb: number;
  last_played: string;
  game_mode: string;
}

export const listInstanceFiles = (instanceId: string, subPath?: string) =>
  invoke<FileEntry[]>("list_instance_files", { instanceId, subPath });
export const listInstanceWorlds = (instanceId: string) =>
  invoke<WorldEntry[]>("list_instance_worlds", { instanceId });
export const openInstanceFolder = (instanceId: string, subPath?: string) =>
  invoke<void>("open_instance_folder", { instanceId, subPath });
export const getInstanceLogs = (instanceId: string) =>
  invoke<string[]>("get_instance_logs", { instanceId });
export const getCrashReport = (path: string) =>
  invoke<string>("get_crash_report", { path });
