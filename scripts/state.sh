# Private strict-v2 state parser and presenter for the shared core and renderers.

# All persisted identifiers are deliberately bounded ASCII tokens. This keeps
# records safe to pass through tmux formats without evaluating stored content.
tas_valid_identifier() {
	[ "${#1}" -le 96 ] || return 1
	printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$' 2>/dev/null
}

tas_valid_optional_identifier() {
	[ "$1" = - ] || tas_valid_identifier "$1"
}

tas_valid_liveness() {
	[ "$1" = - ] && return 0
	printf '%s\n' "$1" | grep -Eq '^pid:[1-9][0-9]{0,9}$' 2>/dev/null
}

tas_valid_generation() {
	printf '%s\n' "$1" | grep -Eq '^g:[0-9a-f]{32}$' 2>/dev/null
}

tas_valid_effective_generation() {
	tas_valid_generation "$1" && return 0
	case $1 in
	d:*) tas_valid_identifier "${1#d:}" ;;
	*) return 1 ;;
	esac
}

tas_valid_requests() {
	[ "$1" != - ] || return 1
	[ "${#1}" -le 1551 ] || return 1
	printf '%s\n' "$1" | awk -F, '
		NF < 1 || NF > 16 { exit 1 }
		{
			for (i = 1; i <= NF; i++) {
				if (length($i) > 96 || $i !~ /^[A-Za-z0-9][A-Za-z0-9._:-]*$/) exit 1
				if (i > 1 && previous >= $i) exit 1
				previous = $i
			}
		}
	' >/dev/null 2>&1
}

tas_load_schema() {
	LC_ALL=C
	export LC_ALL
	tas_newline='
'
}

tas_read_option() {
	tas_option=$(tmux show-option -gqv "$1" 2>/dev/null && printf x) || return 1
	tas_option=${tas_option%x}
	case $tas_option in
	*"$tas_newline") tas_option=${tas_option%"$tas_newline"} ;;
	*) return 1 ;;
	esac
	case $tas_option in
	*'
'*) return 1 ;;
	esac
}

tas_load_options() {
	tas_load_schema
	tas_read_option @tmux-agents-status-running-glyph || return 1
	tas_running_glyph=$tas_option
	tas_read_option @tmux-agents-status-running-style || return 1
	tas_running_style=$tas_option
	tas_read_option @tmux-agents-status-waiting-glyph || return 1
	tas_waiting_glyph=$tas_option
	tas_read_option @tmux-agents-status-waiting-style || return 1
	tas_waiting_style=$tas_option
	tas_read_option @tmux-agents-status-completed-glyph || return 1
	tas_completed_glyph=$tas_option
	tas_read_option @tmux-agents-status-completed-style || return 1
	tas_completed_style=$tas_option
	tas_read_option @tmux-agents-status-failed-glyph || return 1
	tas_failed_glyph=$tas_option
	tas_read_option @tmux-agents-status-failed-style || return 1
	tas_failed_style=$tas_option
	tas_read_option @tmux-agents-status-unread-style || return 1
	tas_unread_style=$tas_option
}

tas_read_stored_record() {
	tas_error=
	tas_pane=$1
	tas_record=$(tmux show-option -sqv "@tmux-agents-status-state-$tas_pane" 2>/dev/null && printf x) || {
		tas_error=query
		return 1
	}
	tas_record=${tas_record%x}
	tas_record=${tas_record%"$tas_newline"}
	case $tas_record in
	*'
'*) return 1 ;;
	esac
	[ -n "$tas_record" ] || return 1
	[ "${#tas_record}" -le 2048 ] || return 1
}

tas_parse_record() {
	[ "${#1}" -le 2048 ] || return 1
	case $1 in *'
'*) return 1 ;; esac
	printf '%s\n' "$1" | awk -F '|' 'NF == 8 { found = 1 } END { exit !found }' >/dev/null 2>&1 || return 1
	IFS='|' read -r tas_version tas_owner tas_liveness tas_turn tas_state tas_generation tas_resume tas_requests <<EOF
$1
EOF
	[ "$tas_version" = v2 ] || return 1
	tas_valid_optional_identifier "$tas_turn" || return 1
	case $tas_state in
	none | running)
		tas_valid_identifier "$tas_owner" || return 1
		tas_valid_liveness "$tas_liveness" || return 1
		[ "$tas_generation" = - ] && [ "$tas_resume" = - ] && [ "$tas_requests" = - ] || return 1
		;;
	waiting)
		tas_valid_identifier "$tas_owner" || return 1
		tas_valid_liveness "$tas_liveness" || return 1
		tas_valid_generation "$tas_generation" || return 1
		case $tas_resume in none | running) ;; *) return 1 ;; esac
		tas_valid_requests "$tas_requests" || return 1
		;;
	completed | failed)
		if [ "$tas_owner" = - ]; then
			[ "$tas_liveness" = - ] || return 1
		else
			tas_valid_identifier "$tas_owner" || return 1
			tas_valid_liveness "$tas_liveness" || return 1
		fi
		tas_valid_generation "$tas_generation" || return 1
		[ "$tas_resume" = - ] && [ "$tas_requests" = - ] || return 1
		;;
	*) return 1 ;;
	esac
}

tas_read_ack() {
	tas_ack=$(tmux show-option -sqv "@tmux-agents-status-ack-$tas_pane" 2>/dev/null && printf x) || {
		tas_error=query
		return 1
	}
	tas_ack=${tas_ack%x}
	tas_ack=${tas_ack%"$tas_newline"}
	case $tas_ack in *'
'*) tas_ack= ;; esac
	if [ -n "$tas_ack" ] && ! tas_valid_effective_generation "$tas_ack"; then
		tas_ack=
	fi
}

tas_read_state() {
	tas_load_schema
	tas_read_stored_record "$1" || return 1
	tas_parse_record "$tas_record" || return 1

	[ "$tas_state" != none ] || return 1
	tas_live=true
	case $tas_liveness in
	pid:*)
		tas_pid=${tas_liveness#pid:}
		kill -0 "$tas_pid" 2>/dev/null || tas_live=false
		;;
	esac
	if [ "$tas_live" = false ]; then
		case $tas_state in
		running | waiting)
			tas_state=failed
			tas_generation=d:$tas_owner
			;;
		esac
	fi

	case $tas_state in
	running)
		_tas_glyph=${tas_running_glyph-}
		_tas_style=${tas_running_style-}
		tas_unread=false
		;;
	waiting)
		_tas_glyph=${tas_waiting_glyph-}
		_tas_style=${tas_waiting_style-}
		tas_unread=true
		;;
	completed)
		_tas_glyph=${tas_completed_glyph-}
		_tas_style=${tas_completed_style-}
		tas_unread=true
		;;
	failed)
		_tas_glyph=${tas_failed_glyph-}
		_tas_style=${tas_failed_style-}
		tas_unread=true
		;;
	esac

	if [ "$tas_unread" = true ]; then
		tas_read_ack || return 1
		[ "$tas_ack" != "$tas_generation" ] || tas_unread=false
	fi
	return 0
}

tas_present_glyph() {
	tas_present_value=$1
	tas_present_style=$2
	tas_present_unread=$3
	tas_present_escaped=$(printf '%s' "$tas_present_value" | sed 's/#/##/g' 2>/dev/null) || return 1
	if [ "$tas_present_unread" = true ] && [ -n "$tas_unread_style" ]; then
		tas_present_style=${tas_present_style:+$tas_present_style,}$tas_unread_style
	fi
	if [ -n "$tas_present_style" ]; then
		printf '#[%s]%s#[default]' "$tas_present_style" "$tas_present_escaped"
	else
		printf '%s' "$tas_present_escaped"
	fi
}
