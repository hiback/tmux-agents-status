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

tmux set-option -goq @tmux-agents-status-window '#(#{q:@tmux-agents-status-root}/scripts/render-window #{q:session_id} #{q:window_id} #{q:pane_id})'
tmux set-option -goq @tmux-agents-status-other-sessions '#(#{q:@tmux-agents-status-root}/scripts/render-other-sessions #{q:session_id})'
tmux set-option -goq @tmux-agents-status-running-glyph '•'
tmux set-option -goq @tmux-agents-status-running-style 'fg=cyan'
tmux set-option -goq @tmux-agents-status-waiting-glyph '?'
tmux set-option -goq @tmux-agents-status-waiting-style 'fg=yellow'
tmux set-option -goq @tmux-agents-status-completed-glyph '✓'
tmux set-option -goq @tmux-agents-status-completed-style 'fg=green'
tmux set-option -goq @tmux-agents-status-failed-glyph '!'
tmux set-option -goq @tmux-agents-status-failed-style 'fg=red'
tmux set-option -goq @tmux-agents-status-unread-style 'reverse,bold'
