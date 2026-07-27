# Tmux Agents Status

Show coding-agent activity in the tmux status bar, including active turns and unread results in other panes or sessions.

- `•` an agent is working
- `?` an agent is waiting for user input (when its adapter supports this)
- `✓` an agent finished
- `!` an agent failed or was cancelled
- Unread results are highlighted until you visit their pane

![Tmux status bar showing agent activity](assets/tmux-agents-status.png)

There is no background daemon. Native adapters send bounded lifecycle events to the shared tmux core, and status is refreshed only when agent or tmux state changes. The core is the only component that persists tmux lifecycle state.

## Requirements

- tmux 3.0 or newer on Linux or macOS
- At least one supported agent, running directly inside a tmux pane:
  - [Pi](https://github.com/badlogic/pi-mono) 0.81.1 or newer, in TUI mode
  - [OpenCode](https://opencode.ai) 1.15.11 or newer
  - [Claude Code](https://code.claude.com) 2.1.79 or newer

## Install

The canonical tmux core and at least one native agent adapter are required. Pi, OpenCode, and Claude Code are the adapters implemented in this checkout. Install only the adapters you use; each one has its own package lifecycle and never touches another agent's configuration.

### 1. Install the tmux plugin

#### With TPM

Add this line to `~/.tmux.conf` before TPM's `run` line:

```tmux
set -g @plugin 'hiback/tmux-agents-status'
```

Reload tmux, then press `prefix` + `I` to install the plugin.

#### Without TPM

Run:

```sh
git clone https://github.com/hiback/tmux-agents-status.git "$HOME/.tmux/plugins/tmux-agents-status"
```

Add this line to `~/.tmux.conf`:

```tmux
run-shell ~/.tmux/plugins/tmux-agents-status/tmux-agents-status.tmux
```

### 2. Install the Pi extension

Until the Pi adapter is published, install its independently versioned package directory from this checkout:

```sh
pi install ./packages/pi
```

Then enter `/reload` in Pi, or restart Pi. The package contains only the Pi adapter; it discovers and invokes the canonical core loaded by tmux and becomes a no-op when that core is missing or protocol-incompatible.

### 3. Install the OpenCode plugin

Until the OpenCode adapter is published, register its independently versioned package directory from this checkout:

```sh
opencode plugin --global /absolute/path/to/tmux-agents-status/packages/opencode
```

Restart OpenCode. The package contains only the OpenCode adapter and discovers the same canonical core. Re-run the command with `--force` to move a registered entry to a newer package spec.

OpenCode has no plugin removal command yet. To uninstall, remove only that package entry from the `plugin` array in `~/.config/opencode/opencode.json`.

### 4. Install the Claude Code plugin

Add this repository as a Claude Code marketplace and install its plugin at user scope:

```sh
claude plugin marketplace add hiback/tmux-agents-status
claude plugin install tmux-agents-status@tmux-agents-status --scope user
```

Start or restart Claude Code inside tmux. The marketplace contains only the Claude Code adapter; its hooks discover the same canonical core and become a no-op when that core is missing or protocol-incompatible. Claude Code owns enablement, caching, updates, and removal:

```sh
claude plugin update tmux-agents-status@tmux-agents-status --scope user
claude plugin uninstall tmux-agents-status@tmux-agents-status --scope user
```

Adapters run as your user. Install them only from source you trust.

## Add the status fragments

Loading the plugin does **not** modify your existing status bar. Add the following strings to the existing option values in `~/.tmux.conf`.

### Window status

Append this exact string **once, at the end** of both `window-status-format` and `window-status-current-format`:

```tmux
#{E:@tmux-agents-status-window}
```

For example, change:

```tmux
set -g window-status-format '#I:#W'
set -g window-status-current-format '#I:#W'
```

to:

```tmux
set -g window-status-format '#I:#W#{E:@tmux-agents-status-window}'
set -g window-status-current-format '#I:#W#{E:@tmux-agents-status-window}'
```

Keep your existing formats; the important part is inserting **`#{E:@tmux-agents-status-window}`** at their ends.

### Other tmux sessions

Insert this exact string **once** into `status-right`:

```tmux
#{E:@tmux-agents-status-other-sessions}
```

Placing it at the beginning is usually simplest. For example, change:

```tmux
set -g status-right '#S %H:%M'
```

to:

```tmux
set -g status-right '#{E:@tmux-agents-status-other-sessions}#S %H:%M'
```

Keep your existing status content; the important part is inserting **`#{E:@tmux-agents-status-other-sessions}`**.

Plugin fragments use tmux's default style. If the content after a fragment needs a specific inline style, reapply that style immediately after the inserted string:

```tmux
set -g status-right '#{E:@tmux-agents-status-other-sessions}#[fg=colour250]#S %H:%M'
```

Replace `#[fg=colour250]` with your theme's style.

### Reload tmux

Apply the configuration without restarting tmux:

```sh
tmux source-file "$HOME/.tmux.conf"
```

## Customize

Put custom options in `~/.tmux.conf` before the TPM `run` line or manual `run-shell` line.

```tmux
set -g @tmux-agents-status-running-glyph 'RUN'
set -g @tmux-agents-status-running-style 'fg=blue,bold'
set -g @tmux-agents-status-completed-glyph '✓'
set -g @tmux-agents-status-completed-style 'fg=green'
set -g @tmux-agents-status-failed-glyph '!'
set -g @tmux-agents-status-failed-style 'fg=red'
set -g @tmux-agents-status-unread-style 'reverse,bold'
```

Available options:

| Option | Default | Purpose |
| --- | --- | --- |
| `@tmux-agents-status-running-glyph` | `•` | Active turn |
| `@tmux-agents-status-running-style` | `fg=cyan` | Active-turn style |
| `@tmux-agents-status-waiting-glyph` | `?` | Waiting state |
| `@tmux-agents-status-waiting-style` | `fg=yellow` | Waiting-state style |
| `@tmux-agents-status-completed-glyph` | `✓` | Completed turn |
| `@tmux-agents-status-completed-style` | `fg=green` | Completed-turn style |
| `@tmux-agents-status-failed-glyph` | `!` | Failed or cancelled turn |
| `@tmux-agents-status-failed-style` | `fg=red` | Failed-turn style |
| `@tmux-agents-status-unread-style` | `reverse,bold` | Added to unread results |

Set a glyph to an empty string to hide that state. Styles use tmux syntax without the surrounding `#[...]`.

## How it behaves

The window fragment shows one symbol for each tracked agent pane in the current tmux window. A waiting, finished, or failed symbol remains visible, while unread styling disappears after you visit the pane.

The other-session fragment shows active turns and unread results from other tmux sessions. Panes linked to the current session are not counted twice.

Pi `/reload` keeps the current status. Starting a new, resumed, or forked Pi session replaces ownership and clears the old status until the next turn begins. Closing a pane removes its status.

Pi reports exact `running` from accepted `agent_start` through `agent_settled`. Settled `stop` and terminal `toolUse` outcomes map approximately to `completed`; settled `error`, `length`, and `aborted` outcomes map approximately to `failed`. Retries, compaction, tools, and queued continuations stay running until settlement. Generic Pi waits are unsupported and are never inferred.

OpenCode reports exact `running` while its root session is busy, exact `waiting` while permission or question requests are pending, exact `completed` when the session goes idle without failure evidence, and exact `failed` when the session ends with typed error, abort, or rejection evidence. Retries stay running. Subagent and background child sessions never take the pane over. Starting work in another root session replaces the pane status; merely selecting a different already-idle session is not reported by OpenCode and leaves the status unchanged until that session works again. Quitting OpenCode releases the pane, and abandoned work is reported as failed.

An OpenCode turn that continues after a rejected request, which its non-default continued-on-deny behavior allows, is reported as completed once its assistant message settles normally.

Claude Code reports approximate `running` from prompt submission and later foreground tool activity, approximate `waiting` from permission and question hooks, exact `waiting` for paired MCP elicitation, approximate `completed` from main-agent stop or idle-prompt evidence, and exact `failed` only for terminal API errors. Later foreground activity repairs approximate waiting and completion, while an exact failure stays final. User cancellation and all other failure classes are unsupported and never invent a terminal state. Subagent activity never takes the pane over, and `/resume` or `/clear` replaces pane ownership. Because Claude Code exposes no reliable long-lived process identity, abrupt termination may leave stale state until graceful session end, a later session claim, or pane exit.

Adapters and the core exchange protocol major 2 lifecycle identifiers only. They do not inspect or persist prompts, responses, tool arguments, transcripts, model text, or pane content. v1, future-version, malformed, and oversized tmux records are ignored.

## Uninstall the tmux core

Run the core cleanup while the checkout still exists:

```sh
~/.tmux/plugins/tmux-agents-status/scripts/uninstall
```

The command removes only live tmux state owned by this plugin: its hook entries and markers, defaults recorded as plugin-owned, pane records and acknowledgements, protocol metadata, and root metadata. It is safe to run repeatedly. It does not edit `~/.tmux.conf`, status formats, or other user hooks and options. Changed, pre-existing, or unmarked legacy option values are retained as user-owned live configuration.

The command prints the exact plugin declaration and status-fragment strings to remove manually from your tmux configuration. Remove the applicable lines and fragments, then remove the checkout through TPM or delete the manual clone. Native agent adapters have separate package lifecycles and are not removed by this core command.

## Troubleshooting

If nothing appears:

1. Confirm both the tmux plugin and your agent's adapter are installed.
2. Confirm both exact fragment strings were added to `~/.tmux.conf`.
3. Run `tmux source-file "$HOME/.tmux.conf"`.
4. Enter `/reload` in Pi, or restart OpenCode or Claude Code.
5. Start a turn inside tmux and allow about one second for the first update.

The adapters are intentionally inactive outside tmux, in Pi print, JSON, or RPC modes, and wherever the core is missing or protocol-incompatible.

## Limitations

- One directly running main agent per pane is supported; subagents and background work do not take pane ownership.
- The agent and tmux must run on the same host.
- OpenCode reports the same lifecycle from any pane it runs in, including non-interactive commands; it exposes no native signal that separates them.
- Claude Code cannot report user cancellation or most failure classes; an interrupted turn keeps its last reported state until the next prompt or session end.
- Nested tmux, SSH aggregation, and Windows are not supported.
