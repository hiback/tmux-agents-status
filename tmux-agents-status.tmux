#!/bin/sh
set -eu

version=$(tmux display-message -p '#{version}')
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

install_default() {
    option=$1
    marker=$2
    value=$3
    owned=false
    if ! tmux show-options -g "$option" >/dev/null 2>&1; then
        owned=true
    fi
    tmux set-option -goq "$option" "$value"
    if [ "$owned" = true ]; then
        tmux set-option -s "$marker" 1
    fi
}
for hook in window-pane-changed session-window-changed client-session-changed client-attached; do
    marker=@tmux-agents-status-hook-$hook
    if [ -z "$(tmux show-option -sqv "$marker" 2>/dev/null)" ]; then
        tmux set-hook -ag "$hook" 'run-shell "#{q:@tmux-agents-status-root}/scripts/acknowledge #{q:pane_id}"'
        tmux set-option -s "$marker" 1
    fi
done
marker=@tmux-agents-status-hook-pane-exited
if [ -z "$(tmux show-option -sqv "$marker" 2>/dev/null)" ]; then
    tmux set-hook -ag pane-exited 'run-shell "#{q:@tmux-agents-status-root}/scripts/cleanup-pane #{q:hook_pane}"'
    tmux set-option -s "$marker" 1
fi
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
