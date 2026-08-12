#!/usr/bin/env bash

set -euo pipefail

readonly SYSTEM_LAUNCHER="${NOMAD_SYSTEM_LAUNCHER:-/usr/local/bin/nomad-session}"
readonly SYSTEM_DESKTOP="${NOMAD_SYSTEM_DESKTOP:-/usr/share/xsessions/nomad.desktop}"
readonly SYSTEM_MARKER="${NOMAD_SYSTEM_MARKER:-/usr/local/share/nomad/session-v0.3-a}"
readonly SYSTEM_MARKER_DIR="$(dirname -- "$SYSTEM_MARKER")"
readonly USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/nomad"
readonly USER_I3_CONFIG="$USER_CONFIG_DIR/i3/config"
readonly USER_MARKER="$USER_CONFIG_DIR/.session-v0.3-a-installed"
readonly USER_BIN_DIR="${NOMAD_USER_BIN_DIR:-$HOME/.local/bin}"
readonly USER_CLI="$USER_BIN_DIR/nomad"
readonly USER_CLI_MARKER="$USER_CONFIG_DIR/.cli-v0.4-d-installed"
readonly CLI_MARKER_HEADER="NOMAD-UI CLI v0.4-d"

if [[ -e "$SYSTEM_MARKER" ]]; then
    sudo rm -f -- "$SYSTEM_LAUNCHER" "$SYSTEM_DESKTOP" "$SYSTEM_MARKER"
    sudo rmdir --ignore-fail-on-non-empty "$SYSTEM_MARKER_DIR"
else
    printf 'System marker absent; leaving system files untouched.\n'
fi

if [[ -f "$USER_CLI_MARKER" && ! -L "$USER_CLI_MARKER" ]]; then
    mapfile -t cli_marker_lines <"$USER_CLI_MARKER"
    if [[ "${cli_marker_lines[0]:-}" == "$CLI_MARKER_HEADER" && -n "${cli_marker_lines[1]:-}" ]]; then
        cli_source="${cli_marker_lines[1]}"
        if [[ -L "$USER_CLI" && "$(readlink -- "$USER_CLI")" == "$cli_source" ]]; then
            rm -f -- "$USER_CLI"
            printf 'Removed the NOMAD-owned CLI launcher.\n'
        elif [[ -e "$USER_CLI" || -L "$USER_CLI" ]]; then
            printf 'CLI launcher changed; leaving it untouched: %s\n' "$USER_CLI"
        fi
        rm -f -- "$USER_CLI_MARKER"
    else
        printf 'CLI marker is not NOMAD-owned; leaving CLI files untouched.\n'
    fi
elif [[ -e "$USER_CLI_MARKER" || -L "$USER_CLI_MARKER" ]]; then
    printf 'CLI marker is unsafe; leaving CLI files untouched.\n'
else
    printf 'CLI marker absent; leaving CLI launcher untouched.\n'
fi

if [[ -e "$USER_MARKER" ]]; then
    rm -f -- "$USER_I3_CONFIG" "$USER_MARKER"
    rmdir --ignore-fail-on-non-empty "$USER_CONFIG_DIR/i3" "$USER_CONFIG_DIR"
else
    printf 'User marker absent; leaving user configuration untouched.\n'
fi

printf 'Removed NOMAD session files. GNOME, i3, logs, session.env, and user application data were preserved.\n'
