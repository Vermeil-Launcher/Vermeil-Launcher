# Privacy Policy

Vermeil is a local-first Minecraft launcher. It runs entirely on your computer and has no servers operated by Vermeil itself.

## What Vermeil does NOT do

- Vermeil does not collect telemetry, analytics, crash reports, or any other usage data.
- Vermeil does not have an account system. There is no Vermeil account to sign up for.
- Vermeil does not phone home for any reason.
- Vermeil does not sell, share, or transmit your data to anyone.

## Data stored on your device

Vermeil keeps everything locally under `%LOCALAPPDATA%\Vermeil` (Windows) or `~/.local/share/Vermeil` (Linux). This includes:

- Instance configurations and settings
- Mod, resource pack, and shader files you install
- Game logs from previous play sessions
- Your Microsoft account access token and refresh token, stored in `accounts.json` so you don't have to sign in every launch
- Java runtimes that Vermeil downloaded for you
- Game assets, libraries, and version metadata cached from Mojang's servers

You can delete this folder at any time. The launcher's NSIS uninstaller offers to delete it for you on Windows.

## Third-party services Vermeil talks to

Using Vermeil means making HTTPS requests to the following providers. Vermeil sends only what each service requires to do its job. You are subject to each provider's own privacy policy:

| Service | Why Vermeil contacts it | What's sent |
|---|---|---|
| Microsoft / Xbox Live (`login.microsoftonline.com`, `xboxlive.com`) | Account authentication for online play | Your standard OAuth credentials |
| Mojang / Minecraft Services (`api.minecraftservices.com`, `launchermeta.mojang.com`, `resources.download.minecraft.net`, `textures.minecraft.net`) | Validate your account, download game files, fetch version manifests, fetch your skin and cape textures | Authentication tokens and standard requests |
| Modrinth (`api.modrinth.com`, `cdn.modrinth.com`) | Search and download mods, resource packs, shaders, modpacks | The search queries you make |
| CurseForge (`api.curseforge.com`, `edge.forgecdn.net`) | Search and download CurseForge content (only if enabled) | The search queries you make |
| Adoptium (`api.adoptium.net`) | Download Java runtimes when needed | None |
| Fabric / Quilt / NeoForge / Forge metadata servers | Download mod loader files | None |
| GitHub (`github.com`, `objects.githubusercontent.com`) | Check for and download Vermeil updates | None |

## Microsoft account tokens

When you sign in with a Microsoft account, Vermeil receives an access token from Microsoft that authorizes you to play Minecraft. This token (and a refresh token used to mint new access tokens) is stored on your device in `accounts.json` along with your Minecraft player UUID and username. On Windows, tokens are encrypted at rest using DPAPI (tied to your Windows user session). On Linux, tokens rely on operating system file permissions in your user data directory. The token's scope is limited to Xbox Live and Minecraft Services — it does not grant access to your Microsoft email, OneDrive, or any other Microsoft property.

You can sign out at any time from the Account screen. Signing out removes the tokens from your device. Vermeil does not separately revoke the token on Microsoft's servers — the token expires naturally, or you can revoke it manually from your Microsoft account settings.

## Open source

Vermeil's source code is public. You can review exactly what data is read, sent, and stored by reading the source.

## Contact

This is a solo project. For security-sensitive issues, use GitHub's private vulnerability reporting on the repository.
