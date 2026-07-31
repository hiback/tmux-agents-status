#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-render-style-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-render-style-$$
mkdir "$tmp"

cleanup() {
	tmux -L "$socket" kill-server >/dev/null 2>&1 || :
	rm -rf "$tmp"
}
trap cleanup 0
trap 'exit 1' 1 2 3 15

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

assert_equal() {
	[ "$1" = "$2" ] || fail "$3 (expected '$1', got '$2')"
}

tmux_test() {
	tmux -L "$socket" "$@"
}

option() {
	tmux_test show-option -gqv "$1"
}

tmux_test -f /dev/null new-session -d -s render-style
set -- $(tmux_test display-message -p '#{session_id} #{window_id} #{pane_id}')
session=$1
window=$2
pane=$3
tmux_test run-shell "$root/tmux-agents-status.tmux"
tmux_test set-option -g @tmux-agents-status-running-glyph R
tmux_test set-option -g @tmux-agents-status-waiting-glyph W
tmux_test set-option -g @tmux-agents-status-completed-glyph C
tmux_test set-option -g @tmux-agents-status-failed-glyph F
tmux_test set-option -g @tmux-agents-status-unread-style ''
incarnation=11111111-1111-4111-8111-111111111111
tmux_test set-option -s "@tmux-agents-status-state-$pane" "v2|$incarnation|pid:$$|-|running|-|-|-"
server_tmux="$(tmux_test display-message -p '#{socket_path}'),$$,0"

render_window() {
	TMUX="$server_tmux" "$root/scripts/render-window" "$session" "$window" "$pane"
}

assert_glyph_style() {
	expected_style=$1
	glyph=$2
	label=$3
	if [ -n "$expected_style" ]; then
		expected_glyph="#[$expected_style]$glyph#[default]"
	else
		expected_glyph=$glyph
	fi
	assert_equal "#[push-default]#[default] $expected_glyph#[default]#[pop-default]" "$(render_window)" "$label"
}

mixed_style='FG=RED,push-default BOLD bg=#AaBbCc,align=right'
tmux_test set-option -g @tmux-agents-status-running-style "$mixed_style"
assert_glyph_style 'FG=RED,BOLD,bg=#AaBbCc' R 'mixed styles retain only visual terms in their original order'
assert_equal "$mixed_style" "$(option @tmux-agents-status-running-style)" 'style filtering leaves the stored option unchanged'

tmux_test set-option -g @tmux-agents-status-running-style ', ,bold  ,,fg=red,'
assert_glyph_style 'bold,fg=red' R 'commas, ASCII spaces, and empty separators form a literal style list'

tab=$(printf '\t')
form_feed=$(printf '\f')
tmux_test set-option -g @tmux-agents-status-running-style "bold${tab}reverse,fg=red dim${form_feed}italics"
assert_glyph_style 'fg=red' R 'tabs and other whitespace do not split style terms'

attributes='default,none,bright,bold,dim,underscore,blink,reverse,hidden,italics,strikethrough,overline,double-underscore,curly-underscore,dotted-underscore,dashed-underscore,nobright,nobold,nodim,nounderscore,noblink,noreverse,nohidden,noitalics,nostrikethrough,nooverline,nodouble-underscore,nocurly-underscore,nodotted-underscore,nodashed-underscore'
tmux_test set-option -g @tmux-agents-status-running-style "$attributes"
assert_glyph_style "$attributes" R 'the tmux 3.1 visual attribute vocabulary and negations are retained'

colours='fg=black,fg=red,fg=green,fg=yellow,fg=blue,fg=magenta,fg=cyan,fg=white,fg=brightblack,fg=brightred,fg=brightgreen,fg=brightyellow,fg=brightblue,fg=brightmagenta,fg=brightcyan,fg=brightwhite,fg=0,fg=1,fg=2,fg=3,fg=4,fg=5,fg=6,fg=7,fg=90,fg=91,fg=92,fg=93,fg=94,fg=95,fg=96,fg=97,fg=colour0,fg=colour255,fg=default,fg=terminal,fg=#A1b2C3'
tmux_test set-option -g @tmux-agents-status-running-style "$colours"
assert_glyph_style "$colours" R 'literal named, indexed, default, terminal, and RGB colours are retained'

invalid_colours='fg=8,fg=08,fg=89,fg=98,fg=-1,fg=colour256,fg=colourx,fg=#12345,fg=#1234567,fg=#gg0000,fg=orange,fg=,bg=blue'
tmux_test set-option -g @tmux-agents-status-running-style "$invalid_colours"
assert_glyph_style 'bg=blue' R 'malformed and unsupported colour values are filtered token by token'

structural='fg=yellow,push-default,pop-default,set-default,ignore,align=left,noalign,list=on,nolist,range=left,norange,fill=red,width=3,pad=2,padding=2,hyperlink=example,unknown,bold'
tmux_test set-option -g @tmux-agents-status-running-style "$structural"
assert_glyph_style 'fg=yellow,bold' R 'layout, default-scope, ignore, and unknown terms are filtered token by token'

tmux_test set-option -g @tmux-agents-status-running-style 'push-default align=right unknown'
assert_glyph_style '' R 'a fully filtered style behaves like an empty visual overlay'

for dynamic_style in \
	'fg=red,#{?pane_in_mode,bold,dim}' \
	'fg=red,#(printf bold)' \
	'fg=red,#[bold]'; do
	tmux_test set-option -g @tmux-agents-status-running-style "$dynamic_style"
	assert_glyph_style '' R 'dynamic or nested tmux syntax empties the entire style option'
done
for dynamic_alias in '#D' '#F' '#H' '#h' '#I' '#P' '#S' '#T' '#W'; do
	tmux_test set-option -g @tmux-agents-status-running-style "fg=red,$dynamic_alias,bold"
	assert_glyph_style '' R 'a short dynamic tmux alias empties the entire style option'
done

tmux_test set-option -g @tmux-agents-status-running-style 'fg=#D0a1b2'
assert_glyph_style 'fg=#D0a1b2' R 'an RGB colour is not mistaken for a short dynamic tmux alias'

waiting_generation=g:22222222222222222222222222222222
tmux_test set-option -s "@tmux-agents-status-state-$pane" "v2|$incarnation|pid:$$|-|waiting|$waiting_generation|running|request"
tmux_test set-option -su "@tmux-agents-status-ack-$pane" 2>/dev/null || :
tmux_test set-option -g @tmux-agents-status-waiting-style 'fg=red,push-default,bold'
tmux_test set-option -g @tmux-agents-status-unread-style 'fg=green,nobold,reverse,align=right'
assert_glyph_style 'fg=red,bold,fg=green,nobold,reverse' W 'filtered unread style is layered after filtered state style'

dynamic_unread='fg=green,#{?pane_in_mode,nobold,bold}'
tmux_test set-option -g @tmux-agents-status-unread-style "$dynamic_unread"
assert_glyph_style 'fg=red,bold' W 'an empty dynamic unread option leaves its sibling state overlay intact'
assert_equal "$dynamic_unread" "$(option @tmux-agents-status-unread-style)" 'dynamic-style rejection does not rewrite the stored option'

tmux_test set-option -s "@tmux-agents-status-ack-$pane" "$waiting_generation"
tmux_test set-option -g @tmux-agents-status-unread-style 'fg=green,nobold,reverse'
assert_glyph_style 'fg=red,bold' W 'acknowledgement still removes only the unread overlay'

completed_generation=g:33333333333333333333333333333333
tmux_test set-option -s "@tmux-agents-status-state-$pane" "v2|$incarnation|pid:$$|-|completed|$completed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-ack-$pane" "$completed_generation"
tmux_test set-option -g @tmux-agents-status-completed-style 'fg=colour256,bg=cyan,range=left'
assert_glyph_style 'bg=cyan' C 'completed style uses the same literal visual filter'

failed_generation=g:44444444444444444444444444444444
tmux_test set-option -s "@tmux-agents-status-state-$pane" "v2|$incarnation|pid:$$|-|failed|$failed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-ack-$pane" "$failed_generation"
tmux_test set-option -g @tmux-agents-status-failed-style 'fg=red,#(printf bold)'
assert_glyph_style '' F 'failed style uses the same whole-option dynamic rejection'

tmux_test set-option -su "@tmux-agents-status-state-$pane"
assert_equal '' "$(render_window)" 'an empty renderer result creates no style scope'

printf 'ok - renderer style options are literal visual overlays\n'
