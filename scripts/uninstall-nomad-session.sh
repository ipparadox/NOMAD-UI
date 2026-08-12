#!/usr/bin/env bash

set -euo pipefail

readonly SYSTEM_LAUNCHER="/usr/local/bin/nomad-session"
readonly SYSTEM_DESKTOP="/usr/share/xsessions/nomad.desktop"
readonly SYSTEM_MARKER="/usr/local/share/nomad/session-v0.3-a"
readonly USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/nomad"
readonly USER_I3_CONFIG="$USER_CONFIG_DIR/i3/config"
readonly USER_MARKER="$USER_CONFIG_DIR/.session-v0.3-a-installed"

if [[ -e "$SYSTEM_MARKER" ]]; then
    sudo rm -f -- "$SYSTEM_LAUNCHER" "$SYSTEM_DESKTOP" "$SYSTEM_MARKER"
    sudo rmdir --ignore-fail-on-non-empty /usr/local/share/nomad
else
    printf 'System marker absent; leaving system files untouched.\n'
fi

if [[ -e "$USER_MARKER" ]]; then
    rm -f -- "$USER_I3_CONFIG" "$USER_MARKER"
    rmdir --ignore-fail-on-non-empty "$USER_CONFIG_DIR/i3" "$USER_CONFIG_DIR"
else
    printf 'User marker absent; leaving user configuration untouched.\n'
fi

printf 'Removed NOMAD session files. GNOME, i3, logs, and session.env were preserved.\n'

