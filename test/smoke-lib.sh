# Shared harness for the credentialed real-agent adapter smoke lanes. Every
# assertion reads plugin-owned tmux options only, so prompts, responses, tool
# arguments, transcripts, model text, and raw pane content are never captured.
#
# Callers set `root` to the repository root before sourcing this file.

smoke_fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

smoke_ok() {
	printf 'ok - %s\n' "$1"
}

smoke_tmux() {
	tmux -L "$smoke_socket" "$@"
}

# Stage tracked files only, the way a released core reaches a user, and load it
# through a real configuration file under an isolated home.
smoke_begin() {
	smoke_name=$1
	smoke_socket=tmux-agents-status-smoke-$smoke_name-$$
	smoke_tmp=${TMPDIR:-/tmp}/tmux-agents-status-smoke-$smoke_name-$$
	mkdir "$smoke_tmp"
	smoke_home=$smoke_tmp/home
	smoke_plugin=$smoke_home/.tmux/plugins/tmux-agents-status
	mkdir -p "$smoke_plugin"
	(cd "$root" && git ls-files -z | tar -cf - --null -T -) | tar -xf - -C "$smoke_plugin"

	HOME=$smoke_home
	export HOME
	cat >"$smoke_home/.tmux.conf" <<EOF
set -g window-status-format '#I:#W#{E:@tmux-agents-status-window}'
set -g window-status-current-format '#I:#W#{E:@tmux-agents-status-window}'
run-shell $smoke_plugin/tmux-agents-status.tmux
EOF
	smoke_tmux -f "$smoke_home/.tmux.conf" new-session -d -s smoke
	smoke_tmux set-environment -g HOME "$smoke_home"
	[ "$(smoke_tmux show-option -gqv @tmux-agents-status-root)" = "$smoke_plugin" ] ||
		smoke_fail 'the smoke tmux server loaded the candidate core'
}

smoke_end() {
	tmux -L "$smoke_socket" kill-server >/dev/null 2>&1 || :
	rm -rf "$smoke_tmp"
}

smoke_versions() {
	printf '# agent: %s\n' "$1"
	printf '# tmux: %s\n' "$(tmux -V)"
	printf '# os: %s\n' "$(uname -sm)"
}

# Launch the agent the way a user does: directly, in its own pane, with a real
# PTY and no wrapper.
smoke_launch() {
	smoke_pane=$(smoke_tmux new-window -P -F '#{pane_id}' -d -n agent "$1")
}

smoke_record() {
	smoke_tmux show-option -sqv "@tmux-agents-status-state-$smoke_pane"
}

smoke_field() {
	smoke_record | cut -d'|' -f"$1"
}

smoke_state() {
	smoke_field 5
}

# Poll the persisted record rather than the agent, so a slow model turn extends
# only this bound and never the plugin's own propagation bound.
smoke_await() {
	expected=$1
	limit=$2
	label=$3
	deadline=$(($(date +%s) + limit))
	while :; do
		actual=$(smoke_state)
		[ "$actual" = "$expected" ] && {
			smoke_ok "$label"
			return 0
		}
		[ "$(date +%s)" -lt "$deadline" ] ||
			smoke_fail "$label (waited ${limit}s, last state '${actual:--}')"
		sleep .2
	done
}

smoke_await_claim() {
	prefix=$1
	limit=$2
	deadline=$(($(date +%s) + limit))
	while :; do
		owner=$(smoke_field 2)
		case $owner in
		"$prefix":?*)
			case $(smoke_field 3) in
			pid:[1-9]*)
				smoke_ok 'a direct launch discovers the core and claims its pane'
				return 0
				;;
			esac
			;;
		esac
		[ "$(date +%s)" -lt "$deadline" ] ||
			smoke_fail "a direct launch discovers the core and claims its pane (waited ${limit}s)"
		sleep .2
	done
}

smoke_await_release() {
	limit=$1
	deadline=$(($(date +%s) + limit))
	while :; do
		[ -z "$(smoke_record)" ] && {
			smoke_ok 'quitting leaves no lifecycle record on the pane'
			return 0
		}
		[ "$(date +%s)" -lt "$deadline" ] ||
			smoke_fail "quitting leaves no lifecycle record on the pane (waited ${limit}s)"
		sleep .2
	done
}

# The negative half of the uninstall check: a relaunched agent must stay silent
# for a window longer than its own startup.
smoke_expect_no_claim() {
	deadline=$(($(date +%s) + $1))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		[ -z "$(smoke_record)" ] ||
			smoke_fail 'an uninstalled adapter no longer claims its pane'
		sleep .2
	done
	smoke_ok 'an uninstalled adapter no longer claims its pane'
}

smoke_type() {
	smoke_tmux send-keys -t "$smoke_pane" -l -- "$1"
	sleep .5
	smoke_tmux send-keys -t "$smoke_pane" Enter
}

smoke_key() {
	smoke_tmux send-keys -t "$smoke_pane" "$1"
}
