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
- [Pi](https://github.com/badlogic/pi-mono) 0.81.1 or newer, running in TUI mode
- Pi must run directly inside a tmux pane

## Install

The canonical tmux core and at least one native agent adapter are required. Pi is the adapter implemented in this checkout.

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

The extension runs as your user. Install it only from source you trust.

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

Adapters and the core exchange protocol major 2 lifecycle identifiers only. They do not inspect or persist prompts, responses, tool arguments, transcripts, model text, or pane content. v1, future-version, malformed, and oversized tmux records are ignored.

## Troubleshooting

If nothing appears:

1. Confirm both the tmux plugin and Pi extension are installed.
2. Confirm both exact fragment strings were added to `~/.tmux.conf`.
3. Run `tmux source-file "$HOME/.tmux.conf"`.
4. Enter `/reload` in Pi.
5. Start a Pi turn inside tmux and allow about one second for the first update.

The extension is intentionally inactive outside tmux and in Pi print, JSON, or RPC modes.

## Limitations

- One directly running main agent per pane is supported; subagents and background work do not take pane ownership.
- The agent and tmux must run on the same host.
- Nested tmux, SSH aggregation, and Windows are not supported.
