# In-game capes — PoC (done)

Proved the mechanism end-to-end before scaling to more versions.

## Established
- A client-side Fabric mod renders a local cape PNG on the player even with no Mojang cape.
- Static and animated (frame strip) both work.
- Live-reload: mod polls the cape files and applies changes (toggle / swap / speed) without a restart.
- Launcher integration: download-on-demand mod install + global cape dir + one on/off toggle.

## Distribution
- Mod jars are **not** bundled in the launcher and **not** committed. Published as GitHub release assets on `mod-v*` tags with a `companion-manifest.json`; launcher fetches the matching `(version, loader)` jar (SHA-1 verified) into the instance's `mods/`.

## Where it lives
- Separate Gradle projects under `companion-mod/fabric/`, each folder named by the full MC range it covers (`26.1-26.2/`, `1.21-1.21.1/`, `1.21.11/`), outside the launcher's pnpm/cargo build. Intermediate 1.21.x eras are archived under `companion-mod/archive/fabric/`.
