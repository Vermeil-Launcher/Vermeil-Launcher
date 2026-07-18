# Vermeil mod

Companion Fabric mod for the [Vermeil launcher](https://github.com/Vermeil-Launcher/Vermeil-Launcher).

Its first feature is rendering the launcher's local **custom capes** in-game —
the vanilla client can only show Mojang-granted capes, so a client-side mod is
required to display a custom one. The launcher writes the baked cape texture to
a known local path and this mod renders it.

This is an early proof of concept. See
[`docs/research/ingame-capes/`](../docs/research/ingame-capes/) in the launcher
repo for the design and the version/loader support reasoning.

## Target

- Minecraft 26.1.x, Java 25 (see `gradle.properties`).
- Fabric (a Fabric build also runs on Quilt). Other loaders/versions come later.

## Build

Requires JDK 25. From this folder:

```
./gradlew build
```

The built jar lands in `build/libs/`. To test, drop it (plus Fabric API) into a
Fabric instance's `mods/` folder and launch.

## License

MIT — see [LICENSE](LICENSE).
