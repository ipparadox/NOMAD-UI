#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly SESSION_SOURCE="$REPO_ROOT/session"
readonly SYSTEM_LAUNCHER="/usr/local/bin/nomad-session"
readonly SYSTEM_DESKTOP="/usr/share/xsessions/nomad.desktop"
readonly SYSTEM_MARKER="/usr/local/share/nomad/session-v0.3-a"
readonly USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/nomad"
readonly USER_I3_CONFIG="$USER_CONFIG_DIR/i3/config"
readonly USER_ENV="$USER_CONFIG_DIR/session.env"
readonly USER_MARKER="$USER_CONFIG_DIR/.session-v0.3-a-installed"

for source_file in nomad-session nomad.desktop i3.config; do
    [[ -f "$SESSION_SOURCE/$source_file" ]] || {
        printf 'Missing source file: %s\n' "$SESSION_SOURCE/$source_file" >&2
        exit 1
    }
done

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

sudo install -D -m 0755 "$SESSION_SOURCE/nomad-session" "$SYSTEM_LAUNCHER"
sudo install -D -m 0644 "$SESSION_SOURCE/nomad.desktop" "$SYSTEM_DESKTOP"
sudo install -D -m 0644 /dev/null "$SYSTEM_MARKER"

install -D -m 0644 "$SESSION_SOURCE/i3.config" "$USER_I3_CONFIG"
if [[ ! -e "$USER_ENV" ]]; then
    printf '%s\n' \
        '# Optional NOMAD session overrides (shell syntax).' \
        '# NOMAD_ROOT="$HOME/Projects/NOMAD-UI"' \
        '# NVM_DIR="$HOME/.nvm"' >"$USER_ENV"
    chmod 0644 "$USER_ENV"
fi
install -m 0644 /dev/null "$USER_MARKER"

printf 'Installed the NOMAD session. Log out, select NOMAD in GDM, and sign in.\n'

