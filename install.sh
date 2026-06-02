#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║              Vermeil Launcher — Linux Installer                 ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# Usage:
#   curl -fsSL https://github.com/davekb1976-beep/Vermeil-Launcher/releases/latest/download/install.sh | bash
#
# Uninstall:
#   vermeil-uninstall

set -euo pipefail

REPO="davekb1976-beep/Vermeil-Launcher"
APP_NAME="Vermeil"
APP_ID="com.vermeil.launcher"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICONS_DIR="$HOME/.local/share/icons/hicolor/128x128/apps"
DATA_DIR="$HOME/.local/share/Vermeil"
DESKTOP_DIR="$HOME/Desktop"

# ── Banner ──────────────────────────────────────────────────────────

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║     Vermeil Launcher — Installer      ║"
echo "  ╠═══════════════════════════════════════╣"
echo "  ║  A lightweight Minecraft launcher     ║"
echo "  ║  for Windows and Linux                ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ── Confirmation ────────────────────────────────────────────────────

printf "  Install Vermeil Launcher? [Y/n] "
read -r CONFIRM < /dev/tty
if [[ "${CONFIRM,,}" == "n" ]]; then
  echo "  Cancelled."
  exit 0
fi

# ── Detect existing install ─────────────────────────────────────────

if [ -f "$BIN_DIR/Vermeil.AppImage" ]; then
  echo ""
  echo "  Existing installation found at $BIN_DIR/Vermeil.AppImage"
  printf "  Overwrite with latest version? [Y/n] "
  read -r OVERWRITE < /dev/tty
  if [[ "${OVERWRITE,,}" == "n" ]]; then
    echo "  Cancelled."
    exit 0
  fi
  echo "  Removing old version..."
  rm -f "$BIN_DIR/Vermeil.AppImage"
fi

# ── Fetch latest release ────────────────────────────────────────────

echo ""
echo "  Fetching latest release..."
LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -Po '"tag_name": "\K[^"]+')
VERSION="${LATEST#v}"
echo "  Latest version: $VERSION"

# ── Download ────────────────────────────────────────────────────────

APPIMAGE_NAME="${APP_NAME}_${VERSION}_amd64.AppImage"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST/$APPIMAGE_NAME"

mkdir -p "$BIN_DIR"
echo "  Downloading $APPIMAGE_NAME..."
curl -fSL --progress-bar "$DOWNLOAD_URL" -o "$BIN_DIR/Vermeil.AppImage"
chmod +x "$BIN_DIR/Vermeil.AppImage"
echo "  Downloaded to $BIN_DIR/Vermeil.AppImage"

# ── Desktop entry (app menu) ───────────────────────────────────────

mkdir -p "$APPS_DIR"
cat > "$APPS_DIR/$APP_ID.desktop" << EOF
[Desktop Entry]
Name=Vermeil
Comment=A lightweight Minecraft launcher
Exec=$BIN_DIR/Vermeil.AppImage
Icon=vermeil
Type=Application
Categories=Game;
StartupWMClass=Vermeil
Terminal=false
EOF

# ── Extract icon ────────────────────────────────────────────────────

mkdir -p "$ICONS_DIR"
# Extract icon from AppImage
cd /tmp
"$BIN_DIR/Vermeil.AppImage" --appimage-extract "*.png" &>/dev/null || true
"$BIN_DIR/Vermeil.AppImage" --appimage-extract "usr/share/icons/*" &>/dev/null || true
ICON_FOUND=""
for candidate in \
  "squashfs-root/usr/share/icons/hicolor/128x128/apps/"*.png \
  "squashfs-root/128x128.png" \
  "squashfs-root/icon.png" \
  "squashfs-root/"*.png; do
  if [ -f "$candidate" ]; then
    ICON_FOUND="$candidate"
    break
  fi
done
if [ -n "$ICON_FOUND" ]; then
  cp "$ICON_FOUND" "$ICONS_DIR/vermeil.png"
fi
rm -rf squashfs-root
cd - >/dev/null

# Update icon cache
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database "$APPS_DIR" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
fi

# ── Desktop shortcut (optional) ─────────────────────────────────────

echo ""
if [ -d "$DESKTOP_DIR" ]; then
  printf "  Create a desktop shortcut? [Y/n] "
  read -r SHORTCUT < /dev/tty
  if [[ "${SHORTCUT,,}" != "n" ]]; then
    cp "$APPS_DIR/$APP_ID.desktop" "$DESKTOP_DIR/$APP_ID.desktop"
    chmod +x "$DESKTOP_DIR/$APP_ID.desktop"
    echo "  Desktop shortcut created."
  fi
fi

# ── Create uninstall script ─────────────────────────────────────────

cat > "$BIN_DIR/vermeil-uninstall" << 'UNINSTALL'
#!/usr/bin/env bash
set -euo pipefail

APP_ID="com.vermeil.launcher"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICONS_DIR="$HOME/.local/share/icons/hicolor/128x128/apps"
DATA_DIR="$HOME/.local/share/Vermeil"
DESKTOP_DIR="$HOME/Desktop"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║    Vermeil Launcher — Uninstaller     ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

printf "  Remove Vermeil Launcher? [Y/n] "
read -r CONFIRM < /dev/tty
if [[ "${CONFIRM,,}" == "n" ]]; then
  echo "  Cancelled."
  exit 0
fi

echo "  Removing application..."
rm -f "$BIN_DIR/Vermeil.AppImage"
rm -f "$APPS_DIR/$APP_ID.desktop"
rm -f "$DESKTOP_DIR/$APP_ID.desktop" 2>/dev/null || true
rm -f "$ICONS_DIR/vermeil.png"

echo ""
if [ -d "$DATA_DIR" ] || [ -d "$HOME/.config/com.vermeil.launcher" ] || [ -d "$HOME/.local/share/com.vermeil.launcher" ]; then
  echo "  App data found:"
  [ -d "$DATA_DIR" ] && echo "    $DATA_DIR (instances, accounts, settings, mods)"
  [ -d "$HOME/.config/com.vermeil.launcher" ] && echo "    ~/.config/com.vermeil.launcher (window state, config)"
  [ -d "$HOME/.local/share/com.vermeil.launcher" ] && echo "    ~/.local/share/com.vermeil.launcher (WebView cache)"
  printf "  Delete all app data and cache? [y/N] "
  read -r DELETE_DATA < /dev/tty
  if [[ "${DELETE_DATA,,}" == "y" ]]; then
    rm -rf "$DATA_DIR"
    rm -rf "$HOME/.config/com.vermeil.launcher"
    rm -rf "$HOME/.local/share/com.vermeil.launcher"
    echo "  All app data and cache deleted."
  else
    echo "  App data preserved."
  fi
fi

# Remove self
rm -f "$BIN_DIR/vermeil-uninstall"

update-desktop-database "$APPS_DIR" 2>/dev/null || true
echo ""
echo "  Vermeil has been uninstalled."
echo ""
UNINSTALL
chmod +x "$BIN_DIR/vermeil-uninstall"

# ── Done ────────────────────────────────────────────────────────────

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║        Installation complete!         ║"
echo "  ╠═══════════════════════════════════════╣"
echo "  ║  Run:        Vermeil.AppImage         ║"
echo "  ║  Uninstall:  vermeil-uninstall        ║"
echo "  ║  App data:   ~/.local/share/Vermeil   ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
echo "  Vermeil should appear in your application menu."
echo ""

# Check PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "  NOTE: $BIN_DIR is not in your PATH."
  echo "  Add this to ~/.bashrc or ~/.zshrc:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi
