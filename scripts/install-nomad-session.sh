#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly SESSION_SOURCE="$REPO_ROOT/session"
readonly CLI_SOURCE="$REPO_ROOT/bin/nomad"
readonly SYSTEM_LAUNCHER="${NOMAD_SYSTEM_LAUNCHER:-/usr/local/bin/nomad-session}"
readonly SYSTEM_DESKTOP="${NOMAD_SYSTEM_DESKTOP:-/usr/share/xsessions/nomad.desktop}"
readonly SYSTEM_MARKER="${NOMAD_SYSTEM_MARKER:-/usr/local/share/nomad/session-v0.3-a}"
readonly USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/nomad"
readonly USER_I3_CONFIG="$USER_CONFIG_DIR/i3/config"
readonly USER_ENV="$USER_CONFIG_DIR/session.env"
readonly USER_MARKER="$USER_CONFIG_DIR/.session-v0.3-a-installed"
readonly USER_BIN_DIR="${NOMAD_USER_BIN_DIR:-$HOME/.local/bin}"
readonly USER_CLI="$USER_BIN_DIR/nomad"
readonly USER_CLI_MARKER="$USER_CONFIG_DIR/.cli-v0.4-d-installed"
readonly CLI_MARKER_HEADER="NOMAD-UI CLI v0.4-d"

for source_file in nomad-session nomad.desktop i3.config; do
    [[ -f "$SESSION_SOURCE/$source_file" ]] || {
        printf 'Missing source file: %s\n' "$SESSION_SOURCE/$source_file" >&2
        exit 1
    }
done
[[ -x "$CLI_SOURCE" ]] || {
    printf 'Missing executable CLI source: %s\n' "$CLI_SOURCE" >&2
    exit 1
}

if [[ ! -e "$SYSTEM_MARKER" ]]; then
    for target in "$SYSTEM_LAUNCHER" "$SYSTEM_DESKTOP"; do
        [[ ! -e "$target" ]] || {
            printf 'Refusing to overwrite an unmanaged file: %s\n' "$target" >&2
            exit 1
        }
    done
fi

if [[ ! -e "$USER_MARKER" && -e "$USER_I3_CONFIG" ]]; then
    printf 'Refusing to overwrite an unmanaged file: %s\n' "$USER_I3_CONFIG" >&2
    exit 1
fi

if [[ -L "$USER_ENV" || ( -e "$USER_ENV" && ! -f "$USER_ENV" ) ]]; then
    printf 'Refusing an unsafe NOMAD session environment file: %s\n' "$USER_ENV" >&2
    exit 1
fi

if [[ -e "$USER_CLI_MARKER" || -L "$USER_CLI_MARKER" ]]; then
    [[ -f "$USER_CLI_MARKER" && ! -L "$USER_CLI_MARKER" ]] || {
        printf 'Refusing an unsafe NOMAD CLI marker: %s\n' "$USER_CLI_MARKER" >&2
        exit 1
    }
    mapfile -t cli_marker_lines <"$USER_CLI_MARKER"
    [[ "${cli_marker_lines[0]:-}" == "$CLI_MARKER_HEADER" && "${cli_marker_lines[1]:-}" == "$CLI_SOURCE" ]] || {
        printf 'Refusing an unmanaged NOMAD CLI marker: %s\n' "$USER_CLI_MARKER" >&2
        exit 1
    }
    if [[ -e "$USER_CLI" || -L "$USER_CLI" ]]; then
        [[ -L "$USER_CLI" && "$(readlink -- "$USER_CLI")" == "$CLI_SOURCE" ]] || {
            printf 'Refusing to overwrite a changed CLI launcher: %s\n' "$USER_CLI" >&2
            exit 1
        }
    fi
elif [[ -e "$USER_CLI" || -L "$USER_CLI" ]]; then
    printf 'Refusing to overwrite an unmanaged file: %s\n' "$USER_CLI" >&2
    exit 1
fi

sudo install -D -m 0755 "$SESSION_SOURCE/nomad-session" "$SYSTEM_LAUNCHER"
sudo install -D -m 0644 "$SESSION_SOURCE/nomad.desktop" "$SYSTEM_DESKTOP"
sudo install -D -m 0644 /dev/null "$SYSTEM_MARKER"

install -D -m 0644 "$SESSION_SOURCE/i3.config" "$USER_I3_CONFIG"
if [[ ! -e "$USER_ENV" ]]; then
    printf '%s\n' \
        '# Optional NOMAD session overrides (shell syntax).' \
        '# NOMAD_ROOT="$HOME/Projects/NOMAD-UI"' \
        '# NVM_DIR="$HOME/.nvm"' >"$USER_ENV"
    chmod 0600 "$USER_ENV"
fi
install -m 0644 /dev/null "$USER_MARKER"

mkdir -p "$USER_BIN_DIR"
if [[ ! -e "$USER_CLI" && ! -L "$USER_CLI" ]]; then
    ln -s -- "$CLI_SOURCE" "$USER_CLI"
fi
cli_marker_temp="$(mktemp "$USER_CONFIG_DIR/.cli-v0.4-d-installed.tmp.XXXXXX")"
chmod 0600 "$cli_marker_temp"
printf '%s\n%s\n' "$CLI_MARKER_HEADER" "$CLI_SOURCE" >"$cli_marker_temp"
mv -f -- "$cli_marker_temp" "$USER_CLI_MARKER"

printf 'Installed the NOMAD session. Log out, select NOMAD in GDM, and sign in.\n'
printf 'Installed the NOMAD CLI launcher at %s.\n' "$USER_CLI"
if [[ ":$PATH:" != *":$USER_BIN_DIR:"* ]]; then
    printf 'Add %s to PATH to run nomad directly.\n' "$USER_BIN_DIR"
fi
