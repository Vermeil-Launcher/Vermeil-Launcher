import { Component, createSignal, createResource, Show, For, onMount } from "solid-js";
import {
  setActiveScreen,
  refetchAccount,
  account,
  showToast,
} from "../App";
import {
  startMsLogin,
  addOfflineAccount,
  getSystemMemory,
  getSettings,
  saveSettings,
  detectJavaInstallations,
  validateJavaPath,
  setJavaPath,
  installRecommendedJava,
  pruneInvalidJavaPaths,
  JavaInstall,
} from "../ipc/commands";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconDownload, IconSearch, IconFolderOpen } from "../components/Icons";
import JavaPathInput from "../components/JavaPathInput";
import JavaChooserModal from "./JavaChooserModal";

/**
 * First-run onboarding wizard.
 *
 * Mounted at app level and gated by `<Show when={onboardingOpen()}>`. App.tsx
 * decides whether to show it by checking `settings.onboarded` and
 * `instances.length === 0` on startup.
 *
 * Four steps:
 *   1. Account — Microsoft sign-in or offline username, reusing the
 *      same IPC commands as the standalone Account screen.
 *   2. Memory  — Slider for `default_memory_mb`, capped at (system - 2 GB)
 *      to mirror the per-instance slider on the Mods → Settings tab.
 *   3. Java    — Same slot UI as Settings → Resources → Java. Optional. If the
 *      user skips entirely, the launcher auto-installs the right JRE the first
 *      time they try to play (existing `ensure_java_public()` behavior). The
 *      step is here so power users can pre-pick an existing JDK before any
 *      Adoptium download kicks off.
 *   4. Choice  — Send the user to either the modpack browser or the custom
 *      setup screen. Both branches mark `onboarded = true` first.
 *
 * Closing the wizard mid-flow flips `onboarded = true` so we don't pester
 * the user again. They can still revisit Settings to configure things.
 */

type WizardStep = 1 | 2 | 3 | 4;

const [open, setOpen] = createSignal(false);
const [step, setStep] = createSignal<WizardStep>(1);

/** Open the onboarding wizard from anywhere (e.g. from App.tsx onMount). */
export function openOnboarding() {
  setStep(1);
  setOpen(true);
}

/** Read by App.tsx to know whether to render the wizard at all. */
export const onboardingOpen = open;

const memoryHintText = (mb: number) => {
  if (mb <= 1024) return "Very low — may struggle with vanilla";
  if (mb <= 2048) return "Minimum for vanilla Minecraft";
  if (mb <= 4096) return "Good for vanilla and light modpacks";
  if (mb <= 6144) return "Recommended for most modpacks";
  if (mb <= 8192) return "Good for large modpacks (100+ mods)";
  if (mb <= 12288) return "High — only needed for heavy modpacks";
  return "Very high — may cause GC stuttering";
};
const memoryHintLevel = (mb: number): string => {
  if (mb <= 1024) return "warn";
  if (mb <= 2048) return "low";
  if (mb <= 8192) return "good";
  if (mb <= 12288) return "high";
  return "warn";
};

/**
 * Pick a sane default allocation given total system RAM.
 * Mirrors what most launchers do: ~25 % of system RAM, clamped 2 – 8 GB.
 */
const recommendedMemoryMb = (systemMb: number): number => {
  if (!systemMb) return 4096;
  const target = Math.round((systemMb * 0.25) / 512) * 512;
  return Math.max(2048, Math.min(target, 8192));
};

/** Persist `onboarded = true` so the wizard never re-appears for this user. */
async function markOnboarded() {
  try {
    const s = await getSettings();
    s.onboarded = true;
    await saveSettings(s);
  } catch (e) {
    // If settings save fails the user just sees the wizard again next launch;
    // not catastrophic, log and move on.
    console.error("Failed to persist onboarded flag:", e);
  }
}

/**
 * Java majors shown in the wizard. Same set as Settings → Resources → Java.
 * Newest first because that's what most new users will need (MC 1.21+ / 26+).
 */
const JAVA_SLOTS: number[] = [25, 21, 17, 8];

const OnboardingWizard: Component = () => {
  const [systemMemoryMb] = createResource(getSystemMemory);
  const [memoryMb, setMemoryMb] = createSignal(4096);
  const [memoryInitialized, setMemoryInitialized] = createSignal(false);

  const [loggingIn, setLoggingIn] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [offlineUsername, setOfflineUsername] = createSignal("");

  // Java step state. Detections are cached locally so the buttons can show
  // an "already installed" state. Per-major busy flag prevents double-clicks.
  const [javaDetections, setJavaDetections] = createSignal<JavaInstall[]>([]);
  const [javaPaths, setJavaPaths] = createSignal<Record<number, string>>({});
  const [javaBusy, setJavaBusy] = createSignal<Record<number, "install" | "detect" | "browse" | null>>({});
  const setJavaSlotBusy = (m: number, b: "install" | "detect" | "browse" | null) =>
    setJavaBusy(prev => ({ ...prev, [m]: b }));
  // Chooser modal state — surfaced when Detect returns more than one match
  // for a major. Mirrors the Settings → Resources behaviour.
  const [chooser, setChooser] = createSignal<{ major: number; options: JavaInstall[] } | null>(null);

  /** Best-known path for a major: user-set > detected. */
  const javaPathFor = (major: number): string => {
    const userSet = javaPaths()[major];
    if (userSet) return userSet;
    return javaDetections().find(i => i.major === major)?.path ?? "";
  };

  // Initialize the memory signal once we know the system RAM. Runs lazily on
  // first render of step 2.
  const ensureMemoryInitialized = async () => {
    if (memoryInitialized()) return;
    try {
      const s = await getSettings();
      const sys = systemMemoryMb() || 16384;
      setMemoryMb(s.default_memory_mb || recommendedMemoryMb(sys));
      setJavaPaths(s.java_paths || {});
    } catch {
      setMemoryMb(recommendedMemoryMb(systemMemoryMb() || 16384));
    } finally {
      setMemoryInitialized(true);
    }
  };

  // Background detection on first mount. Cheap to run — just spawns
  // `java -version` once per candidate path and caches the results. The
  // detection populates the read-only path display under each slot before
  // the user even reaches step 3.
  //
  // We also prune any configured paths that no longer exist on disk so the
  // slot inputs never display a string pointing at nothing — same self-heal
  // pass the Settings tab does on mount.
  onMount(() => {
    pruneInvalidJavaPaths()
      .then((cleared) => {
        if (cleared.length === 0) return;
        // Reflect the prune in the local copy so the UI stays in sync.
        setJavaPaths((prev) => {
          const next = { ...prev };
          for (const m of cleared) delete next[m];
          return next;
        });
        for (const m of cleared) {
          showToast({
            title: `Java ${m} path cleared`,
            message: "The previous file no longer exists on disk.",
            type: "info",
          });
        }
      })
      .catch((e) => console.error("Java path prune failed:", e));
    detectJavaInstallations()
      .then(setJavaDetections)
      .catch(() => {});
  });

  const close = async () => {
    // Treat closing as "I know what I'm doing" — flag onboarded so we don't
    // pester the user again. They can still revisit Settings to tweak memory.
    await markOnboarded();
    setOpen(false);
  };

  const handleMicrosoftLogin = async () => {
    setLoggingIn(true);
    setError(null);
    try {
      await startMsLogin();
      await refetchAccount();
      setStep(2);
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e.message || "Login failed";
      if (msg !== "Login cancelled") setError(msg);
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
      setOfflineUsername("");
      setStep(2);
    } catch (e: any) {
      setError(typeof e === "string" ? e : e.message || "Failed to add account");
    }
  };

  const handleMemoryNext = async () => {
    try {
      const s = await getSettings();
      s.default_memory_mb = memoryMb();
      await saveSettings(s);
    } catch (e) {
      console.error("Failed to save default memory:", e);
    }
    setStep(3);
  };

  // ─── Java step actions ──────────────────────────────────────────────────

  const handleJavaInstall = async (major: number) => {
    setJavaSlotBusy(major, "install");
    try {
      const install = await installRecommendedJava(major);
      setJavaPaths(prev => ({ ...prev, [major]: install.path }));
      setJavaDetections(prev => {
        const without = prev.filter(i => i.path !== install.path);
        return [...without, install];
      });
      showToast({ title: `Java ${major} installed`, message: install.full_version, type: "success" });
    } catch (e) {
      showToast({ title: `Java ${major} install failed`, message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  const handleJavaDetect = async (major: number) => {
    setJavaSlotBusy(major, "detect");
    try {
      const found = await detectJavaInstallations();
      setJavaDetections(found);
      const matches = found.filter(i => i.major === major);
      if (matches.length === 0) {
        showToast({
          title: `Java ${major} not found`,
          message: "Try Install recommended or Browse to point at a JDK.",
          type: "info",
        });
      } else if (matches.length === 1) {
        await applyDetection(major, matches[0]);
      } else {
        // Multiple matches — let the user pick instead of silently grabbing
        // the first by source priority. Same UX as Settings → Resources.
        setChooser({ major, options: matches });
      }
    } catch (e) {
      showToast({ title: "Detection failed", message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  const applyDetection = async (major: number, install: JavaInstall) => {
    await setJavaPath(major, install.path);
    setJavaPaths(prev => ({ ...prev, [major]: install.path }));
    setJavaDetections(prev => {
      const without = prev.filter(i => i.path !== install.path);
      return [...without, install];
    });
    showToast({ title: `Java ${major} set`, message: install.path, type: "success" });
  };

  const handleJavaBrowse = async (major: number) => {
    setJavaSlotBusy(major, "browse");
    try {
      const isWin = navigator.userAgent.includes("Windows");
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: isWin ? [{ name: "Java executable", extensions: ["exe"] }] : [],
      });
      if (!picked) return;
      const path = typeof picked === "string" ? picked : (picked as { path: string }).path;
      const install = await validateJavaPath(path);
      if (install.major !== major) {
        showToast({
          title: `That's Java ${install.major}, not ${major}`,
          message: "Pick a JRE matching the requested major version.",
          type: "warning",
        });
        return;
      }
      await setJavaPath(major, install.path);
      setJavaPaths(prev => ({ ...prev, [major]: install.path }));
      setJavaDetections(prev => {
        const without = prev.filter(i => i.path !== install.path);
        return [...without, install];
      });
      showToast({ title: `Java ${major} updated`, message: install.path, type: "success" });
    } catch (e) {
      showToast({ title: "Browse failed", message: String(e), type: "error" });
    } finally {
      setJavaSlotBusy(major, null);
    }
  };

  // ─── Final-step navigation ──────────────────────────────────────────────

  const goToModpacks = async () => {
    await markOnboarded();
    setOpen(false);
    setActiveScreen("create-modpack");
  };

  const goToCustom = async () => {
    await markOnboarded();
    setOpen(false);
    setActiveScreen("create-custom");
  };

  // ─── Step indicator helper ─────────────────────────────────────────────

  const STEPS: { num: WizardStep; label: string }[] = [
    { num: 1, label: "Account" },
    { num: 2, label: "Memory" },
    { num: 3, label: "Java" },
    { num: 4, label: "Get started" },
  ];

  return (
    <Show when={open()}>
      <div class="modal-overlay">
        <div class="modal onboarding-modal">
          <div class="modal-header">
            <span class="modal-title">Welcome to Vermeil</span>
            <button class="modal-close" onClick={close}>✕</button>
          </div>

          <div class="onboarding-progress">
            <For each={STEPS}>
              {(s, i) => (
                <>
                  <Show when={i() > 0}>
                    <div class={`onboarding-step-line ${step() >= s.num ? "active" : ""}`} />
                  </Show>
                  <div class={`onboarding-step ${step() >= s.num ? "active" : ""}`}>
                    <div class="onboarding-step-num">{s.num}</div>
                    <div class="onboarding-step-label">{s.label}</div>
                  </div>
                </>
              )}
            </For>
          </div>

          {/* Step 1: Account */}
          <Show when={step() === 1}>
            <div class="modal-body">
              <div class="onboarding-heading">Sign in</div>
              <div class="onboarding-subtext">
                Pick a Microsoft account to play online, or use an offline name
                to skip authentication. You can add or switch accounts later.
              </div>

              <div style="margin-top:18px">
                <button
                  class="btn btn-accent"
                  onClick={handleMicrosoftLogin}
                  disabled={loggingIn()}
                  style="width:100%"
                >
                  {loggingIn() ? "Signing in..." : "Sign in with Microsoft"}
                </button>
              </div>

              <div class="onboarding-or">or</div>

              <div class="field-label">Offline username</div>
              <div style="display:flex;gap:8px">
                <input
                  class="field-input"
                  placeholder="Username (1-16 chars)"
                  value={offlineUsername()}
                  onInput={(e) => setOfflineUsername(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleOfflineLogin();
                  }}
                  maxLength={16}
                />
                <button
                  class="btn"
                  onClick={handleOfflineLogin}
                  disabled={!offlineUsername().trim()}
                >
                  Add
                </button>
              </div>

              <Show when={error()}>
                <div class="onboarding-error">{error()}</div>
              </Show>
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onClick={close}>Skip setup</button>
              <button
                class="btn btn-accent"
                onClick={() => setStep(2)}
                disabled={!account()}
              >
                Next
              </button>
            </div>
          </Show>

          {/* Step 2: Memory */}
          <Show when={step() === 2}>
            {(() => {
              ensureMemoryInitialized();
              return null;
            })()}
            <div class="modal-body">
              <div class="onboarding-heading">Memory allocation</div>
              <div class="onboarding-subtext">
                Default RAM for new instances. We picked
                {" "}<b>{(memoryMb() / 1024).toFixed(1).replace(".0", "")} GB</b> based on your
                system's {Math.round((systemMemoryMb() || 0) / 1024)} GB total. You can change this per-instance later.
              </div>

              <div class="memory-slider-wrap" style="margin-top:18px">
                <div class="memory-slider-track-wrap">
                  <div class="memory-slider-dots">
                    {(() => {
                      const max = Math.max((systemMemoryMb() || 16384) - 2048, 4096);
                      const dots = [];
                      for (let gb = 4096; gb <= max; gb += 4096) {
                        const pct = ((gb - 512) / (max - 512)) * 100;
                        dots.push(
                          <div
                            class="memory-dot"
                            classList={{ filled: gb <= memoryMb() }}
                            style={{ left: `${pct}%` }}
                          />,
                        );
                      }
                      return dots;
                    })()}
                  </div>
                  <input
                    type="range"
                    class="memory-slider"
                    min={512}
                    max={Math.max((systemMemoryMb() || 16384) - 2048, 4096)}
                    step={256}
                    value={memoryMb()}
                    style={{
                      "--slider-pct": `${
                        ((memoryMb() - 512) /
                          (Math.max((systemMemoryMb() || 16384) - 2048, 4096) - 512)) *
                        100
                      }%`,
                    }}
                    onInput={(e) => {
                      const v = parseInt(e.currentTarget.value);
                      const snapped = Math.round(v / 512) * 512 || 512;
                      e.currentTarget.value = String(snapped);
                      setMemoryMb(snapped);
                    }}
                  />
                </div>
                <div class="memory-slider-labels">
                  <span>512 MB</span>
                  <span class="memory-slider-value">
                    {(memoryMb() / 1024).toFixed(1).replace(".0", "")} GB
                  </span>
                  <span>
                    {Math.round(
                      Math.max((systemMemoryMb() || 16384) - 2048, 4096) / 1024,
                    )}{" "}
                    GB
                  </span>
                </div>
                <div class={`memory-hint ${memoryHintLevel(memoryMb())}`}>
                  {memoryHintText(memoryMb())}
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
              <button class="btn btn-accent" onClick={handleMemoryNext}>
                Next
              </button>
            </div>
          </Show>

          {/* Step 3: Java */}
          <Show when={step() === 3}>
            <div class="modal-body">
              <div class="onboarding-heading">Java runtimes (optional)</div>
              <div class="onboarding-subtext">
                Each Minecraft major needs its own JRE. Skip this and Vermeil will
                download what you need the first time you play. If you already
                have JDKs installed, point at them now to avoid extra downloads.
              </div>

              <div class="java-slots onboarding-java-slots">
                <For each={JAVA_SLOTS}>
                  {(major) => {
                    const det = () => javaDetections().find(i => i.major === major);
                    const path = () => javaPathFor(major);
                    const installed = () => Boolean(path());
                    const busy = () => javaBusy()[major] ?? null;
                    return (
                      <div class="java-slot">
                        <div class="java-slot-title">Java {major} location</div>
                        <JavaPathInput
                          major={major}
                          value={path()}
                          placeholder={`Not configured — will install on first play`}
                          disabled={busy() !== null}
                          onCommit={async (newPath) => {
                            setJavaPaths(prev => {
                              const next = { ...prev };
                              if (newPath) next[major] = newPath;
                              else delete next[major];
                              return next;
                            });
                            if (newPath) {
                              try {
                                const install = await validateJavaPath(newPath);
                                setJavaDetections(prev => {
                                  const without = prev.filter(i => i.path !== install.path);
                                  return [...without, install];
                                });
                              } catch {
                                // Already toasted by JavaPathInput on the unhappy path.
                              }
                            }
                          }}
                        />
                        <Show when={det() && installed()}>
                          <div class="java-slot-meta">
                            {det()!.full_version} · {det()!.arch} · {det()!.source.replace("_", " ")}
                          </div>
                        </Show>
                        <div class="java-slot-actions">
                          <button
                            class="btn"
                            onClick={() => handleJavaInstall(major)}
                            disabled={busy() !== null}
                            title={installed() ? "Replace with a fresh Adoptium download" : "Download from Adoptium"}
                          >
                            <IconDownload />
                            {busy() === "install" ? "Installing..." : "Install recommended"}
                          </button>
                          <button
                            class="btn"
                            onClick={() => handleJavaDetect(major)}
                            disabled={busy() !== null}
                          >
                            <IconSearch />
                            {busy() === "detect" ? "Detecting..." : "Detect"}
                          </button>
                          <button
                            class="btn"
                            onClick={() => handleJavaBrowse(major)}
                            disabled={busy() !== null}
                          >
                            <IconFolderOpen />
                            {busy() === "browse" ? "Picking..." : "Browse"}
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onClick={() => setStep(2)}>Back</button>
              <button class="btn btn-accent" onClick={() => setStep(4)}>
                Continue
              </button>
            </div>
          </Show>

          {/* Step 4: First instance choice */}
          <Show when={step() === 4}>
            <div class="modal-body">
              <div class="onboarding-heading">Create your first instance</div>
              <div class="onboarding-subtext">
                You're all set. Pick how you'd like to start — drop into a curated
                modpack, or build a custom setup yourself.
              </div>

              <div class="onboarding-choices">
                <div class="onboarding-choice" onClick={goToModpacks}>
                  <div class="onboarding-choice-icon" style="color:var(--blue)">📦</div>
                  <div class="onboarding-choice-text">
                    <div class="onboarding-choice-title">Install a modpack</div>
                    <div class="onboarding-choice-desc">
                      Browse and install one-click modpacks from Modrinth.
                    </div>
                  </div>
                </div>
                <div class="onboarding-choice" onClick={goToCustom}>
                  <div class="onboarding-choice-icon" style="color:var(--accent)">⚙</div>
                  <div class="onboarding-choice-text">
                    <div class="onboarding-choice-title">Custom setup</div>
                    <div class="onboarding-choice-desc">
                      Pick your version and loader, then add mods later.
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onClick={() => setStep(3)}>Back</button>
              <button class="btn btn-ghost" onClick={close}>I'll decide later</button>
            </div>
          </Show>
        </div>
      </div>

      {/* Chooser modal — sibling of the wizard's overlay so it stacks on
          top via DOM order. The wizard's `.modal-overlay` doesn't close on
          backdrop click, so dismissing the chooser leaves the wizard intact
          underneath. */}
      <Show when={chooser()}>
        <JavaChooserModal
          major={chooser()!.major}
          options={chooser()!.options}
          onCancel={() => setChooser(null)}
          onPick={async (install) => {
            const major = chooser()!.major;
            setChooser(null);
            await applyDetection(major, install);
          }}
        />
      </Show>
    </Show>
  );
};

export default OnboardingWizard;
