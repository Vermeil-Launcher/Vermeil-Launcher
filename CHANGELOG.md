## 0.2.3

### Fixed

- Modpack install from Modrinth no longer fails with "error decoding response body" when the API returns a non-200 response (rate limit, 404, or CloudFlare challenge). Status is now checked before JSON parsing, with descriptive error messages.
- CurseForge modpacks browsed in the modpack browser can now be installed directly. Previously, clicking Install on a CurseForge modpack incorrectly sent its project ID to the Modrinth API, which always failed.

### Changed

- Skin viewer animation transition (elytra ↔ regular) now ramps smoothly over 300ms instead of snapping instantly.
