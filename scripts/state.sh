# Private shared state parser and presenter for status renderers.

tas_read_option() {
	tas_option=$(tmux show-option -gqv "$1" && printf x) || return 1
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

tas_load_schema() {
	tas_uuid='[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}'
	tas_newline='
'
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

tas_read_state() {
	tas_pane=$1
	tas_record=$(tmux show-option -sqv "@tmux-agents-status-state-$tas_pane" && printf x) || return 1
	tas_record=${tas_record%x}
	tas_record=${tas_record%"$tas_newline"}
	case $tas_record in
	*'
'*) return 1 ;;
	esac
	printf '%s\n' "$tas_record" | grep -Eq "^v1\\|[1-9][0-9]*\\|$tas_uuid\\|(running\\|-|(waiting|completed|failed)\\|$tas_uuid)$" || return 1

	tas_owner=${tas_record#v1|}
	tas_owner=${tas_owner%%|*}
	if kill -0 "$tas_owner" 2>/dev/null; then
		tas_live=true
	else
		tas_live=false
	fi

	tas_fields=${tas_record#*|}
	tas_fields=${tas_fields#*|}
	tas_fields=${tas_fields#*|}
	tas_state=${tas_fields%%|*}
	tas_generation=${tas_fields#*|}
	case $tas_state in
	running)
		[ "$tas_live" = true ] || return 1
		_tas_glyph=${tas_running_glyph-}
		_tas_style=${tas_running_style-}
		tas_unread=false
		;;
	waiting)
		[ "$tas_live" = true ] || return 1
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
		tas_ack=$(tmux show-option -sqv "@tmux-agents-status-ack-$tas_pane" && printf x) || tas_ack=x
		tas_ack=${tas_ack%x}
		tas_ack=${tas_ack%"$tas_newline"}
		case $tas_ack in
		*'
'*) tas_ack= ;;
		esac
		if printf '%s\n' "$tas_ack" | grep -Eq "^$tas_uuid$" && [ "$tas_ack" = "$tas_generation" ]; then
			tas_unread=false
		fi
	fi
	[ "$tas_live" = true ] || [ "$tas_unread" = true ]
}

tas_present_glyph() {
	tas_present_value=$1
	tas_present_style=$2
	tas_present_unread=$3
	tas_present_escaped=$(printf '%s' "$tas_present_value" | sed 's/#/##/g') || return 1
	if [ "$tas_present_unread" = true ] && [ -n "$tas_unread_style" ]; then
		tas_present_style=${tas_present_style:+$tas_present_style,}$tas_unread_style
	fi
	if [ -n "$tas_present_style" ]; then
		printf '#[%s]%s#[default]' "$tas_present_style" "$tas_present_escaped"
	else
		printf '%s' "$tas_present_escaped"
	fi
}
