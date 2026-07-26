# Tmux Agents Status

Show Pi activity in the tmux status bar, including active turns and unread results in other panes or sessions.

- `•` Pi is working
- `✓` Pi finished
- `!` Pi failed or was cancelled
- Unread results are highlighted until you visit their pane

![Tmux status bar showing agent activity](assets/tmux-agents-status.png)

There is no background daemon. The status is refreshed when Pi or tmux state changes.

## Requirements

- tmux 3.0 or newer on Linux or macOS
- [Pi](https://github.com/badlogic/pi-mono) 0.80.4 or newer, running in TUI mode
- Pi must run directly inside a tmux pane

## Install

The tmux plugin and Pi extension are both required.

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

Install this repository as a Pi package:

```sh
pi install git:github.com/hiback/tmux-agents-status
```

Then enter `/reload` in Pi, or restart Pi.
Run `pi update --extensions` to update it.

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

The window fragment shows one symbol for each Pi pane in the current tmux window. A finished or failed symbol remains visible, while unread styling disappears after you visit the pane.

The other-session fragment shows active turns and unread results from other tmux sessions. Panes linked to the current session are not counted twice.

Pi `/reload` keeps the current status. Starting a new, resumed, or forked Pi session clears the old status until the next turn begins. Closing a pane removes its status.

## Troubleshooting

If nothing appears:

1. Confirm both the tmux plugin and Pi extension are installed.
2. Confirm both exact fragment strings were added to `~/.tmux.conf`.
3. Run `tmux source-file "$HOME/.tmux.conf"`.
4. Enter `/reload` in Pi.
5. Start a Pi turn inside tmux and allow about one second for the first update.

The extension is intentionally inactive outside tmux and in Pi print, JSON, or RPC modes.

## Limitations

- One directly running Pi process per pane is supported.
- Pi and tmux must run on the same host.
- Nested tmux, SSH aggregation, and Windows are not supported.
