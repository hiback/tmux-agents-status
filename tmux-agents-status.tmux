#!/bin/sh
set -eu

# Config-load time has no current target on tmux 3.0, so the version cannot be
# read through a format.
version=$(tmux -V)
version=${version#tmux }
major=${version%%.*}
case $major in
    '' | *[!0-9]*) supported=false ;;
    *) [ "$major" -ge 3 ] && supported=true || supported=false ;;
esac
if [ "$supported" = false ]; then
    printf 'tmux-agents-status: tmux 3.0 or newer is required (found %s)\n' "$version" >&2
    exit 1
fi

root=$(CDPATH= cd "$(dirname "$0")" && pwd -P)

tmux set-option -g @tmux-agents-status-root "$root"
tmux set-option -g @tmux-agents-status-protocol 2

global_option_exists() {
    option=$1
    options=$(tmux show-options -g 2>/dev/null) || return 1
    printf '%s\n' "$options" | awk -v option="$option" '
        $1 == option { found = 1 }
        END { exit !found }
    ' >/dev/null 2>&1
}

install_default() {
    option=$1
    marker=$2
    value=$3
    owned=false
    if ! global_option_exists "$option"; then
        owned=true
    fi
    tmux set-option -goq "$option" "$value"
    if [ "$owned" = true ]; then
        tmux set-option -s "$marker" 1
    fi
}

hook_matches() {
    hook=$1
    selector=$2
    command=$3
    case $selector in "$hook"\[[0-9]*\]) ;; *) return 1 ;; esac
    tmux show-hooks -g "$hook" 2>/dev/null | awk -v selector="$selector" -v command="$command" '
        $1 == selector {
            sub(/^[^[:space:]]+[[:space:]]+/, "")
            if ($0 == command) found = 1
        }
        END { exit !found }
    '
}

find_hook_selector() {
    hook=$1
    command=$2
    tmux show-hooks -g "$hook" 2>/dev/null | awk -v hook="$hook" -v command="$command" '
        $1 ~ ("^" hook "\\[[0-9]+\\]$") {
            candidate = $1
            sub(/^[^[:space:]]+[[:space:]]+/, "")
            if ($0 == command) {
                number = candidate
                sub("^" hook "\\[", "", number)
                sub("\\]$", "", number)
                if (!found || number > maximum) {
                    found = 1
                    maximum = number
                    selector = candidate
                }
            }
        }
        END { if (found) print selector }
    '
}

install_hook() {
    hook=$1
    marker=$2
    command=$3
    selector=$(tmux show-option -sqv "$marker" 2>/dev/null || :)
    if [ "$selector" = 1 ]; then
        # Legacy markers prove ownership of one indistinguishable matching
        # occurrence. Record one selector without removing any hook.
        selector=$(find_hook_selector "$hook" "$command")
        case $selector in
        "$hook"\[[0-9]*\]) tmux set-option -s "$marker" "$selector"; return ;;
        esac
    fi
    if [ -n "$selector" ] && hook_matches "$hook" "$selector" "$command"; then
        return
    fi
    tmux set-option -su "$marker" 2>/dev/null || :
    tmux set-hook -ag "$hook" "$command"
    selector=$(find_hook_selector "$hook" "$command")
    case $selector in "$hook"\[[0-9]*\]) tmux set-option -s "$marker" "$selector" ;; *) tmux set-option -s "$marker" 1 ;; esac
}

ack_command='run-shell "#{q:@tmux-agents-status-root}/scripts/acknowledge #{q:pane_id}"'
for hook in window-pane-changed session-window-changed client-session-changed client-attached; do
    install_hook "$hook" "@tmux-agents-status-hook-$hook" "$ack_command"
done
cleanup_command='run-shell "#{q:@tmux-agents-status-root}/scripts/cleanup-pane #{q:hook_pane}"'
install_hook pane-exited @tmux-agents-status-hook-pane-exited "$cleanup_command"
"$root/scripts/cleanup-stale" || :

install_default @tmux-agents-status-window @tmux-agents-status-default-window '#(#{q:@tmux-agents-status-root}/scripts/render-window #{q:session_id} #{q:window_id} #{q:pane_id})'
install_default @tmux-agents-status-other-sessions @tmux-agents-status-default-other-sessions '#(#{q:@tmux-agents-status-root}/scripts/render-other-sessions #{q:session_id})'
install_default @tmux-agents-status-running-glyph @tmux-agents-status-default-running-glyph '•'
install_default @tmux-agents-status-running-style @tmux-agents-status-default-running-style 'fg=cyan'
install_default @tmux-agents-status-waiting-glyph @tmux-agents-status-default-waiting-glyph '?'
install_default @tmux-agents-status-waiting-style @tmux-agents-status-default-waiting-style 'fg=yellow'
install_default @tmux-agents-status-completed-glyph @tmux-agents-status-default-completed-glyph '✓'
install_default @tmux-agents-status-completed-style @tmux-agents-status-default-completed-style 'fg=green'
install_default @tmux-agents-status-failed-glyph @tmux-agents-status-default-failed-glyph '!'
install_default @tmux-agents-status-failed-style @tmux-agents-status-default-failed-style 'fg=red'
install_default @tmux-agents-status-unread-style @tmux-agents-status-default-unread-style 'reverse,bold'
