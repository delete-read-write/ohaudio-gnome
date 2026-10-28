#!/usr/bin/env bash
# OhAudio-Gnome: https://github.com/delete-read-write/ohaudio-gnome
# Builds the extension package and installs it for the current user.
set -euo pipefail
cd "$(dirname "$0")"

UUID=ohaudio-gnome@delete-read-write

mkdir -p build
gnome-extensions pack --force --out-dir=build \
    --extra-source=draw.js --extra-source=cava.js --extra-source=i18n.js \
    --schema=schemas/org.gnome.shell.extensions.ohaudio-gnome.gschema.xml \
    .
gnome-extensions install --force "build/$UUID.shell-extension.zip"
# Make sure the settings schema is compiled where the shell looks for it.
glib-compile-schemas "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID/schemas"

if ! command -v cava >/dev/null; then
    echo
    echo "Heads up: cava is not installed. Get it from your package manager, e.g.:"
    echo "    sudo dnf install cava      # Fedora"
    echo "    sudo apt install cava      # Debian / Ubuntu"
    echo "    sudo pacman -S cava        # Arch"
fi

echo
echo "Installed. Log out and back in, then enable it:"
echo "    gnome-extensions enable $UUID"
