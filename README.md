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
  - [Codex](https://developers.openai.com/codex) 0.145.0 or newer

## Install

The canonical tmux core and at least one native agent adapter are required. Pi, OpenCode, Claude Code, and Codex are the adapters implemented in this checkout. Install only the adapters you use; each one has its own package lifecycle and never touches another agent's configuration.

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

#### Update

With TPM, press `prefix` + `U` and select the plugin. Without TPM, pull the clone:

```sh
git -C "$HOME/.tmux/plugins/tmux-agents-status" pull
```

Then run `tmux source-file "$HOME/.tmux.conf"`. Reloading is idempotent.

### 2. Install the Pi extension

Until the Pi adapter is published, install its independently versioned package directory from this checkout:

```sh
pi install /absolute/path/to/tmux-agents-status/packages/pi
```

Then enter `/reload` in Pi, or restart Pi. Pi owns the package lifecycle:

```sh
pi update --extensions
pi remove /absolute/path/to/tmux-agents-status/packages/pi
```

### 3. Install the OpenCode plugin

Until the OpenCode adapter is published, register its independently versioned package directory from this checkout:

```sh
opencode plugin --global /absolute/path/to/tmux-agents-status/packages/opencode
```

Restart OpenCode. Re-run the command with `--force` to move a registered entry to a newer package spec.

OpenCode has no plugin removal command yet. To uninstall, remove only that package entry from the `plugin` array in `~/.config/opencode/opencode.json`.

### 4. Install the Claude Code plugin

Add this repository as a Claude Code marketplace and install its plugin at user scope:

```sh
claude plugin marketplace add hiback/tmux-agents-status
claude plugin install tmux-agents-status@tmux-agents-status --scope user
```

Start or restart Claude Code inside tmux. Claude Code owns enablement, caching, updates, and removal:

```sh
claude plugin update tmux-agents-status@tmux-agents-status --scope user
claude plugin uninstall tmux-agents-status@tmux-agents-status --scope user
```

### 5. Install the Codex plugin

Add this repository as a Codex marketplace and install its plugin:

```sh
codex plugin marketplace add hiback/tmux-agents-status
codex plugin add tmux-agents-status@tmux-agents-status
```

Installing a plugin does not trust its hooks. Start Codex inside tmux and answer its hook review, or run `/hooks`, review the exact `tmux-agents-status` hook definition, and trust it. Until you do, the adapter stays inactive. Reviewing the definition again is required whenever it changes; a release that leaves it unchanged stays trusted. Codex owns enablement, caching, updates, and removal:

```sh
codex plugin marketplace upgrade tmux-agents-status
codex plugin add tmux-agents-status@tmux-agents-status
codex plugin remove tmux-agents-status@tmux-agents-status
```

Upgrading refreshes the marketplace snapshot; installing again is what moves the plugin to the newer version.

Optionally, Codex's separate `notify` program can report the same completion signal. It is not a hook, so it is not covered by hook trust, and Codex allows only one of them; it is therefore user-owned configuration that this repository never writes. To use it, point `notify` in `~/.codex/config.toml` at the installed adapter:

```toml
notify = ["/absolute/path/to/plugin/bin/tmux-agents-status-hook"]
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
| `@tmux-agents-status-running-glyph` | `•` | Working |
| `@tmux-agents-status-running-style` | `fg=cyan` | Working style |
| `@tmux-agents-status-waiting-glyph` | `?` | Waiting |
| `@tmux-agents-status-waiting-style` | `fg=yellow` | Waiting style |
| `@tmux-agents-status-completed-glyph` | `✓` | Finished |
| `@tmux-agents-status-completed-style` | `fg=green` | Finished style |
| `@tmux-agents-status-failed-glyph` | `!` | Failed |
| `@tmux-agents-status-failed-style` | `fg=red` | Failed style |
| `@tmux-agents-status-unread-style` | `reverse,bold` | Added to unread results |

Set a glyph to an empty string to hide that state. Styles use tmux syntax without the surrounding `#[...]`.

## How it behaves

The window fragment shows one symbol for each tracked agent pane in the current tmux window. A waiting, finished, or failed symbol remains visible, while unread styling disappears after you visit the pane.

The other-session fragment shows active turns and unread results from other tmux sessions. Panes linked to the current session are not counted twice. Closing a pane removes its status, and starting a new, resumed, or forked session replaces it.

What actually appears depends on the lifecycle events each agent exposes:

| Agent | Working | Waiting | Finished | Failed |
| --- | --- | --- | --- | --- |
| Pi | yes | not reported | yes | yes |
| OpenCode | yes | yes | yes | yes |
| Claude Code | yes | yes | yes | API errors only |
| Codex | yes | approvals only | yes | not reported |

Where an agent reports nothing, this plugin shows nothing rather than guessing, so a state marked "not reported" simply keeps the previous symbol until the next event. Adapters and the core exchange lifecycle identifiers only. They never inspect or persist prompts, responses, tool arguments, transcripts, model text, or pane content.

## Uninstall the tmux core

Run the core cleanup while the checkout still exists:

```sh
~/.tmux/plugins/tmux-agents-status/scripts/uninstall
```

The command removes only live tmux state that this plugin created. It is safe to run repeatedly, never edits `~/.tmux.conf`, your status formats, or other user hooks, and keeps any option value you set or changed yourself.

The command prints the exact plugin declaration and status-fragment strings to remove manually from your tmux configuration. Remove the applicable lines and fragments, then remove the checkout through TPM or delete the manual clone. Native agent adapters have separate package lifecycles and are not removed by this core command.

## Troubleshooting

If nothing appears:

1. Confirm both the tmux plugin and your agent's adapter are installed.
2. Confirm both exact fragment strings were added to `~/.tmux.conf`.
3. Run `tmux source-file "$HOME/.tmux.conf"`.
4. Enter `/reload` in Pi, or restart OpenCode, Claude Code, or Codex. For Codex, also confirm its hooks are trusted in `/hooks`.
5. Start a turn inside tmux and allow about one second for the first update.

The adapters are intentionally inactive outside tmux, in Pi print, JSON, or RPC modes, and wherever the core is missing or protocol-incompatible.

## Limitations

- One directly running main agent per pane is supported; subagents and background work do not take pane ownership.
- The agent and tmux must run on the same host.
- OpenCode reports the same lifecycle from any pane it runs in, including non-interactive commands; it exposes no native signal that separates them.
- Claude Code cannot report user cancellation or most failure classes; an interrupted turn keeps its last reported state until the next prompt or session end.
- Codex cannot report any failure or cancellation, and its approval waits stay reported until later activity or a reported outcome replaces them.
- Codex hooks stay inactive until you review and trust their exact definition in `/hooks`; the adapter never bypasses that review.
- Nested tmux, SSH aggregation, and Windows are not supported.
