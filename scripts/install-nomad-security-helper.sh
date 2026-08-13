#!/usr/bin/env bash

set -euo pipefail
umask 077
readonly TRUSTED_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PATH="$TRUSTED_PATH"
export PATH

readonly READLINK_EXECUTABLE="/usr/bin/readlink"
readonly STAT_EXECUTABLE="/usr/bin/stat"
readonly SED_EXECUTABLE="/usr/bin/sed"
readonly GREP_EXECUTABLE="/usr/bin/grep"
readonly NODE_EXECUTABLE="/usr/bin/node"
readonly SUDO_EXECUTABLE="/usr/bin/sudo"
readonly INSTALL_EXECUTABLE="/usr/bin/install"
readonly MKTEMP_EXECUTABLE="/usr/bin/mktemp"
readonly RM_EXECUTABLE="/usr/bin/rm"
readonly SCRIPT_DIR="$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly HELPER_SOURCE="$REPO_ROOT/src/security-helper/nomad-security-helper.js"
readonly HELPER_TARGET="/usr/local/libexec/nomad-security-helper"
readonly CONFIG_DIRECTORY="/etc/nomad-security"
readonly CONFIG_TARGET="$CONFIG_DIRECTORY/policy.json"

apply=0
if [[ "$#" -eq 1 && "$1" == "--apply" ]]; then
    apply=1
elif [[ "$#" -ne 0 ]]; then
    printf 'USAGE: %s [--apply]\n' "${0##*/}" >&2
    exit 2
fi

trusted_root_executable() {
    local executable="$1"
    local canonical=""
    local owner=""
    local mode=""
    local parent_path=""
    [[ "$executable" == /* && -x "$executable" ]] || return 1
    canonical="$("$READLINK_EXECUTABLE" -f -- "$executable" 2>/dev/null || true)"
    [[ "$canonical" == /* ]] || return 1
    owner="$("$STAT_EXECUTABLE" -c '%u' -- "$canonical" 2>/dev/null || true)"
    mode="$("$STAT_EXECUTABLE" -c '%a' -- "$canonical" 2>/dev/null || true)"
    [[ "$owner" == "0" && "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 022)) -eq 0 ]] || return 1
    parent_path="$(/usr/bin/dirname -- "$canonical")"
    while true; do
        owner="$("$STAT_EXECUTABLE" -c '%u' -- "$parent_path" 2>/dev/null || true)"
        mode="$("$STAT_EXECUTABLE" -c '%a' -- "$parent_path" 2>/dev/null || true)"
        [[ "$owner" == "0" && "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 022)) -eq 0
            && "$("$READLINK_EXECUTABLE" -f -- "$parent_path" 2>/dev/null || true)" == "$parent_path" ]] || return 1
        [[ "$parent_path" == "/" ]] && return 0
        parent_path="$(/usr/bin/dirname -- "$parent_path")"
    done
}

[[ -f "$HELPER_SOURCE" && ! -L "$HELPER_SOURCE" ]] || {
    printf 'Refusing unsafe helper source: %s\n' "$HELPER_SOURCE" >&2
    exit 1
}
helper_mode="$("$STAT_EXECUTABLE" -c '%a' -- "$HELPER_SOURCE" 2>/dev/null || true)"
[[ -O "$HELPER_SOURCE" && "$("$STAT_EXECUTABLE" -c '%h' -- "$HELPER_SOURCE" 2>/dev/null || true)" == "1"
    && "$("$READLINK_EXECUTABLE" -f -- "$HELPER_SOURCE" 2>/dev/null || true)" == "$HELPER_SOURCE"
    && "$helper_mode" =~ ^[0-7]{3,4}$ && $((8#$helper_mode & 022)) -eq 0 ]] || {
    printf 'Refusing mutable, linked, or unowned helper source: %s\n' "$HELPER_SOURCE" >&2
    exit 1
}
readonly USER_HOME="$("$READLINK_EXECUTABLE" -f -- "${HOME:?HOME is required}")"
[[ "$USER_HOME" == /* && -d "$USER_HOME" && ! -L "$USER_HOME" && -O "$USER_HOME" ]] || {
    printf 'Refusing an unsafe HOME for helper policy generation.\n' >&2
    exit 1
}
readonly USER_CONFIG_BASE="$("$READLINK_EXECUTABLE" -m -- "${XDG_CONFIG_HOME:-$USER_HOME/.config}")"
readonly USER_STATE_BASE="$("$READLINK_EXECUTABLE" -m -- "${XDG_STATE_HOME:-$USER_HOME/.local/state}")"
readonly USER_SETTINGS="$USER_CONFIG_BASE/eDEX-UI/settings.json"

repository_setting="${NOMAD_REPOSITORY_ROOT:-}"
if [[ -z "$repository_setting" && ( -e "$USER_SETTINGS" || -L "$USER_SETTINGS" ) ]]; then
    settings_mode="$("$STAT_EXECUTABLE" -c '%a' -- "$USER_SETTINGS" 2>/dev/null || true)"
    settings_size="$("$STAT_EXECUTABLE" -c '%s' -- "$USER_SETTINGS" 2>/dev/null || true)"
    [[ -f "$USER_SETTINGS" && ! -L "$USER_SETTINGS" && -O "$USER_SETTINGS"
        && "$("$STAT_EXECUTABLE" -c '%h' -- "$USER_SETTINGS" 2>/dev/null || true)" == "1"
        && "$("$READLINK_EXECUTABLE" -f -- "$USER_SETTINGS" 2>/dev/null || true)" == "$USER_SETTINGS"
        && "$settings_mode" =~ ^[0-7]{3,4}$ && $((8#$settings_mode & 022)) -eq 0
        && "$settings_size" =~ ^[0-9]+$ && "$settings_size" -le 1048576 ]] || {
        printf 'Refusing unsafe eDEX settings while resolving the repository root.\n' >&2
        printf 'Repair known NOMAD permissions or set NOMAD_REPOSITORY_ROOT explicitly before installation.\n' >&2
        exit 1
    }
    repository_values=()
    mapfile -t repository_values < <("$SED_EXECUTABLE" -nE \
        's/^[[:space:]]*"repositoryRoot"[[:space:]]*:[[:space:]]*"([A-Za-z0-9._+@%/~ -]+)"[[:space:]]*,?[[:space:]]*$/\1/p' \
        -- "$USER_SETTINGS")
    if [[ "${#repository_values[@]}" -gt 1 ]]; then
        printf 'Multiple repositoryRoot settings were refused.\n' >&2
        exit 1
    elif [[ "${#repository_values[@]}" -eq 1 ]]; then
        repository_setting="${repository_values[0]}"
    elif "$GREP_EXECUTABLE" -q '"repositoryRoot"' -- "$USER_SETTINGS"; then
        printf 'Could not safely resolve repositoryRoot from eDEX settings.\n' >&2
        printf 'Set NOMAD_REPOSITORY_ROOT explicitly before installation.\n' >&2
        exit 1
    fi
fi
if [[ -z "$repository_setting" ]]; then
    repository_setting="$USER_HOME/Repositories"
elif [[ "$repository_setting" == "~" ]]; then
    repository_setting="$USER_HOME"
elif [[ "$repository_setting" == "~/"* ]]; then
    repository_setting="$USER_HOME/${repository_setting:2}"
elif [[ "$repository_setting" != /* ]]; then
    printf 'Repository root must be absolute or use a leading ~/ form.\n' >&2
    exit 1
fi

readonly REPOSITORY_ROOT="$("$READLINK_EXECUTABLE" -m -- "$repository_setting")"
readonly NOMAD_CONFIG_ROOT="$USER_CONFIG_BASE/nomad"
readonly NOMAD_UI_CONFIG_ROOT="$USER_CONFIG_BASE/eDEX-UI"
readonly NOMAD_STATE_ROOT="$USER_STATE_BASE/nomad"
[[ "$REPO_ROOT" =~ ^/[A-Za-z0-9._+@%/\ -]+$ \
    && "$REPOSITORY_ROOT" =~ ^/[A-Za-z0-9._+@%/\ -]+$ \
    && "$USER_HOME" =~ ^/[A-Za-z0-9._+@%/\ -]+$ \
    && "$NOMAD_CONFIG_ROOT" =~ ^/[A-Za-z0-9._+@%/\ -]+$ \
    && "$NOMAD_UI_CONFIG_ROOT" =~ ^/[A-Za-z0-9._+@%/\ -]+$ \
    && "$NOMAD_STATE_ROOT" =~ ^/[A-Za-z0-9._+@%/\ -]+$ ]] || {
    printf 'NOMAD and repository roots must use the supported absolute path character set.\n' >&2
    exit 1
}

render_policy() {
    printf '{\n    "version": 1,\n    "nomadRoot": "%s",\n    "repositoryRoots": ["%s"],\n    "persistentPaths": ["%s", "%s", "%s"],\n    "allowedUnmountRoots": ["/media", "/mnt", "/run/media"]\n}\n' \
        "$REPO_ROOT" "$REPOSITORY_ROOT" "$NOMAD_CONFIG_ROOT" "$NOMAD_UI_CONFIG_ROOT" "$NOMAD_STATE_ROOT"
}

printf 'NOMAD SECURITY HELPER INSTALLATION PLAN\n'
printf 'Install root-owned helper: %s (0755)\n' "$HELPER_TARGET"
printf 'Install root-owned policy: %s (0600)\n' "$CONFIG_TARGET"
printf 'Runtime prerequisite: trusted root-owned %s\n' "$NODE_EXECUTABLE"
printf 'Policy to install:\n'
render_policy
printf 'No firewall or mount change is performed by this installer.\n'
if [[ "$apply" != "1" ]]; then
    printf 'PLAN ONLY: RUN WITH --apply ONLY AFTER REVIEWING THE HELPER AND POLICY ABOVE.\n'
    exit 0
fi

trusted_root_executable "$NODE_EXECUTABLE" || {
    printf 'The trusted helper requires /usr/bin/node; no package will be installed automatically.\n' >&2
    exit 1
}
trusted_root_executable "$SUDO_EXECUTABLE" || {
    printf 'A trusted /usr/bin/sudo is required for the explicit install step.\n' >&2
    exit 1
}
trusted_root_executable "$INSTALL_EXECUTABLE" || {
    printf 'A trusted /usr/bin/install is required for the explicit install step.\n' >&2
    exit 1
}

policy_temp="$("$MKTEMP_EXECUTABLE")"
helper_temp="$("$MKTEMP_EXECUTABLE")"
trap '"$RM_EXECUTABLE" -f -- "$policy_temp" "$helper_temp"' EXIT
render_policy >"$policy_temp"

# Pin the reviewed helper inode before crossing the sudo boundary. This avoids
# reopening a mutable repository pathname as root after the metadata checks.
exec {helper_source_fd}<"$HELPER_SOURCE"
readonly HELPER_SOURCE_FD_PATH="/proc/$$/fd/$helper_source_fd"
helper_fd_owner="$("$STAT_EXECUTABLE" -Lc '%u' -- "$HELPER_SOURCE_FD_PATH" 2>/dev/null || true)"
helper_fd_links="$("$STAT_EXECUTABLE" -Lc '%h' -- "$HELPER_SOURCE_FD_PATH" 2>/dev/null || true)"
helper_fd_mode="$("$STAT_EXECUTABLE" -Lc '%a' -- "$HELPER_SOURCE_FD_PATH" 2>/dev/null || true)"
helper_fd_size="$("$STAT_EXECUTABLE" -Lc '%s' -- "$HELPER_SOURCE_FD_PATH" 2>/dev/null || true)"
[[ -f "$HELPER_SOURCE_FD_PATH" && "$helper_fd_owner" == "$UID" && "$helper_fd_links" == "1"
    && "$helper_fd_mode" =~ ^[0-7]{3,4}$ && $((8#$helper_fd_mode & 022)) -eq 0
    && "$helper_fd_size" =~ ^[0-9]+$ && "$helper_fd_size" -le 1048576 ]] || {
    printf 'Helper source identity changed before installation; no privileged action was taken.\n' >&2
    exit 1
}
"$INSTALL_EXECUTABLE" -m 0700 "$HELPER_SOURCE_FD_PATH" "$helper_temp"
exec {helper_source_fd}<&-
[[ -f "$helper_temp" && ! -L "$helper_temp" && -O "$helper_temp"
    && "$("$STAT_EXECUTABLE" -c '%h' -- "$helper_temp" 2>/dev/null || true)" == "1"
    && "$("$STAT_EXECUTABLE" -c '%a' -- "$helper_temp" 2>/dev/null || true)" == "700" ]] || {
    printf 'Private helper snapshot verification failed; no privileged action was taken.\n' >&2
    exit 1
}

printf 'Requesting administrator authorization for two fixed install operations.\n'
"$SUDO_EXECUTABLE" "$INSTALL_EXECUTABLE" -D -o root -g root -m 0755 "$helper_temp" "$HELPER_TARGET"
"$SUDO_EXECUTABLE" "$INSTALL_EXECUTABLE" -D -o root -g root -m 0600 "$policy_temp" "$CONFIG_TARGET"
printf 'NOMAD security helper installed. Review %s before enforcement.\n' "$CONFIG_TARGET"
