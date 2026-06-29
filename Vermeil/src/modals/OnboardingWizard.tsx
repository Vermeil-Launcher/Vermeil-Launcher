import { Component, createSignal, Show, For, onMount } from "solid-js";
import {
  setActiveScreen,
  refetchAccount,
  account,
  showToast,
} from "../App";
import {
  startMsLogin,
  addOfflineAccount,
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
import { IconDownload, IconSearch, IconFolderOpen, IconLayers, IconSettings } from "../components/Icons";
import JavaPathInput from "../components/JavaPathInput";
import JavaChooserModal from "./JavaChooserModal";

/**
 * First-run onboarding wizard.
 *
 * Mounted at app level and gated by `<Show when={onboardingOpen()}>`. App.tsx
 * decides whether to show it by checking `settings.onboarded` and
 * `instances.length === 0` on startup.
 *
 * Three steps:
 *   1. Account — Microsoft sign-in or offline username, reusing the
 *      same IPC commands as the standalone Account screen.
 *   2. Java    — Same slot UI as Settings → Resources → Java. Optional. If the
 *      user skips entirely, the launcher auto-installs the right JRE the first
 *      time they try to play (existing `ensure_java_public()` behavior). The
 *      step is here so power users can pre-pick an existing JDK before any
 *      Adoptium download kicks off.
 *   3. Choice  — Send the user to either the modpack browser or the custom
 *      setup screen. Both branches mark `onboarded = true` first.
 *
 * Closing the wizard mid-flow flips `onboarded = true` so we don't pester
 * the user again. They can still revisit Settings to configure things.
 */

type WizardStep = 1 | 2 | 3;

const [open, setOpen] = createSignal(false);
const [step, setStep] = createSignal<WizardStep>(1);

/** Open the onboarding wizard from anywhere (e.g. from App.tsx onMount). */
export function openOnboarding() {
  setStep(1);
  setOpen(true);
}

/** Read by App.tsx to know whether to render the wizard at all. */
export const onboardingOpen = open;

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

  // Initialize the Java step's configured paths from settings, plus a
  // background detection + self-heal prune of stale paths. Cheap — spawns
  // `java -version` once per candidate and caches the results.
  onMount(() => {
    getSettings()
      .then((s) => setJavaPaths(s.java_paths || {}))
      .catch(() => {});
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
    { num: 2, label: "Java" },
    { num: 3, label: "Get started" },
  ];

  return (
    <Show when={open()}>
      <div class="modal-overlay">
        <div class="modal onboarding-modal panel panel--bracketed">
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
                  class="btn btn--primary"
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
                  class="field-control field-control--text"
                  placeholder="Username (1-16 chars)"
                  value={offlineUsername()}
                  onInput={(e) => setOfflineUsername(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleOfflineLogin();
                  }}
                  maxLength={16}
                />
                <button
                  class="btn btn--neutral"
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
              <button class="btn btn--ghost" onClick={close}>Skip setup</button>
              <button
                class="btn btn--primary"
                onClick={() => setStep(2)}
                disabled={!account()}
              >
                Next
              </button>
            </div>
          </Show>

          {/* Step 2: Java */}
          <Show when={step() === 2}>
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
                            class="btn btn--neutral"
                            onClick={() => handleJavaInstall(major)}
                            disabled={busy() !== null}
                            title={installed() ? "Replace with a fresh Adoptium download" : "Download from Adoptium"}
                          >
                            <IconDownload />
                            {busy() === "install" ? "Installing..." : "Install recommended"}
                          </button>
                          <button
                            class="btn btn--neutral"
                            onClick={() => handleJavaDetect(major)}
                            disabled={busy() !== null}
                          >
                            <IconSearch />
                            {busy() === "detect" ? "Detecting..." : "Detect"}
                          </button>
                          <button
                            class="btn btn--neutral"
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
              <button class="btn btn--ghost" onClick={() => setStep(1)}>Back</button>
              <button class="btn btn--primary" onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </Show>

          {/* Step 3: First instance choice */}
          <Show when={step() === 3}>
            <div class="modal-body">
              <div class="onboarding-heading">Create your first instance</div>
              <div class="onboarding-subtext">
                You're all set. Pick how you'd like to start — drop into a curated
                modpack, or build a custom setup yourself.
              </div>

              <div class="onboarding-choices">
                <div class="onboarding-choice" onClick={goToModpacks}>
                  <div class="onboarding-choice-icon" style="color:var(--blue)"><IconLayers /></div>
                  <div class="onboarding-choice-text">
                    <div class="onboarding-choice-title">Install a modpack</div>
                    <div class="onboarding-choice-desc">
                      Browse and install one-click modpacks from Modrinth.
                    </div>
                  </div>
                </div>
                <div class="onboarding-choice" onClick={goToCustom}>
                  <div class="onboarding-choice-icon" style="color:var(--accent)"><IconSettings /></div>
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
              <button class="btn btn--ghost" onClick={() => setStep(2)}>Back</button>
              <button class="btn btn--ghost" onClick={close}>I'll decide later</button>
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
