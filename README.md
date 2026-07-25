# tmux Agents Status

A tmux status plugin and an independent [Pi](https://github.com/badlogic/pi-mono) companion for seeing active turns and unread results across panes, windows, and sessions. There is no daemon or polling interval: state changes and pane visits request tmux status-only refreshes.

## Requirements

- tmux 3.0 or newer on Linux or macOS
- Pi 0.81.1 or newer, in TUI mode, for the companion
- `/bin/sh` and POSIX utilities

The tmux plugin and Pi companion are installed and upgraded independently. Neither installs, upgrades, or configures the other.

## Install the tmux plugin

TPM and manual installation load the same executable, `tmux-agents-status.tmux`. Loading the plugin alone does not change any visible status format.

### TPM

No repository remote is published yet. Replace the explicit placeholder below with the repository coordinate supplied by the publisher:

```tmux
set -g @plugin '<OWNER>/<REPOSITORY>'
```

Put that line before TPM's `run` line, then press TPM's install binding. TPM executes `tmux-agents-status.tmux`.

### Manual

Clone or copy the repository to a stable location and load its absolute entrypoint from `.tmux.conf`. For example, if Alice put it at `/home/alice/src/tmux-agents-status`:

```tmux
run-shell /home/alice/src/tmux-agents-status/tmux-agents-status.tmux
```

On macOS an equivalent absolute example is:

```tmux
run-shell /Users/alice/src/tmux-agents-status/tmux-agents-status.tmux
```

Reload `.tmux.conf` or restart the tmux server after changing the path.

## Install the Pi companion

Copy the TypeScript extension independently into Pi's global extension directory:

```sh
mkdir -p ~/.pi/agent/extensions
cp /home/alice/src/tmux-agents-status/pi/tmux-agents-status.ts \
  ~/.pi/agent/extensions/tmux-agents-status.ts
```

Use the real absolute repository path on your machine. Run `/reload` in Pi or restart Pi. The extension activates only for TUI-mode Pi processes running directly inside a tmux pane; print, JSON, RPC, and non-tmux launches are silent no-ops.

The extension runs as your user and should be installed only from source you trust.

## Place the fragments

The plugin never reads or mutates `window-status-format`, `window-status-current-format`, or `status-right`. You place its composable fragments yourself.

Append the window fragment exactly once at the end of both window formats:

```tmux
set -g window-status-format         '#I:#W#{E:@tmux-agents-status-window}'
set -g window-status-current-format '#I:#W#{E:@tmux-agents-status-window}'
```

Place the other-session fragment exactly once in `status-right`:

```tmux
set -g status-right '#{E:@tmux-agents-status-other-sessions}#[default,fg=colour250]#S %H:%M'
```

The `#[default,fg=colour250]` part is only an example of **generic style reapplication**, not a theme preset. Every nonempty plugin fragment starts from and returns to tmux's default style, so enclosing inline attributes do not change plugin content. Reapply whatever `#[...]` style the following part of your theme needs. Keep the window fragment at the end because tmux 3.0 cannot restore an arbitrary preceding inline style.

## Customize

Set overrides before TPM starts or before the manual `run-shell`. Defaults are installed only when an option is unset, so reloads preserve overrides. Styles use tmux's comma-separated style syntax, without the surrounding `#[...]`.

| Option | Exact default | Behavior |
| --- | --- | --- |
| `@tmux-agents-status-window` | `#(#{q:@tmux-agents-status-root}/scripts/render-window #{q:session_id} #{q:window_id} #{q:pane_id})` | Whole current-session window fragment; replace with any tmux format or set empty to hide it. |
| `@tmux-agents-status-other-sessions` | `#(#{q:@tmux-agents-status-root}/scripts/render-other-sessions #{q:session_id})` | Whole other-session fragment; replace with any tmux format or set empty to hide it. |
| `@tmux-agents-status-running-glyph` | `•` | Running glyph; empty also hides the other-session running total. |
| `@tmux-agents-status-running-style` | `fg=cyan` | Running glyph style. |
| `@tmux-agents-status-waiting-glyph` | `?` | Waiting glyph; empty hides waiting records. |
| `@tmux-agents-status-waiting-style` | `fg=yellow` | Waiting glyph style. |
| `@tmux-agents-status-completed-glyph` | `✓` | Completed glyph; empty hides completed records. |
| `@tmux-agents-status-completed-style` | `fg=green` | Completed glyph style. |
| `@tmux-agents-status-failed-glyph` | `!` | Failed glyph; empty hides failed records. |
| `@tmux-agents-status-failed-style` | `fg=red` | Failed glyph style. |
| `@tmux-agents-status-unread-style` | `reverse,bold` | Appended to a state's style for unread alerts; empty disables unread styling without acknowledging alerts. |

Example overrides:

```tmux
set -g @tmux-agents-status-running-glyph 'RUN'
set -g @tmux-agents-status-running-style 'fg=blue,bold'
set -g @tmux-agents-status-waiting-glyph ''
set -g @tmux-agents-status-unread-style 'underscore'
run-shell /home/alice/src/tmux-agents-status/tmux-agents-status.tmux
```

State styles are applied relative to tmux's default style, not inherited from the enclosing format. An empty state style emits its glyph in that default style. If unread style is nonempty, an unread glyph still receives unread styling and a following `#[default]`. Glyphs must be one line, may occupy multiple display cells, and are never measured or truncated by the plugin; the enclosing tmux format owns available width. Literal `#` characters in glyphs and session names are escaped for tmux formats.

## What the status means

| State | Meaning |
| --- | --- |
| `running` | Pi accepted and started a turn. It remains running through tool calls, queued continuations, compaction, and retries. |
| `waiting` | An explicit unresolved approval, question, or elicitation. Ordinary Pi TUI operation does not expose a generic request lifecycle, so this companion never emits or infers waiting from time, pane output, or tool activity. |
| `completed` | The final settled assistant outcome was `stop` or terminal `toolUse`. |
| `failed` | Final settlement was an error, length limit, or cancellation, or active work ended or died. Recoverable tool errors do not directly fail a turn. |

A current-session window fragment starts with one space and shows one glyph per valid Pi pane in pane order. Acknowledged live terminal states remain visible there, without unread emphasis.

The other-session fragment ends with one space. It shows the running glyph plus a total, then unread groups such as `work:?!`. Read alert groups disappear. Panes linked into the current session are excluded; other linked panes are counted once and attributed deterministically.

### Unread acknowledgement

Each waiting, completed, or failed transition has a unique generation. A visit copies only the visible generation into a server-wide acknowledgement option, so acknowledgement from one attached client applies to all clients and cannot hide a later generation. A pane already visible when an alert is published is acknowledged immediately. Rapid or programmatic selection counts only if the pane remains visibly active when the hook checks it. Running is never unread.

### Refresh and lifecycle

State writes, successful acknowledgements, and cleanup request a status-only refresh for every attached client. The plugin does not change `status-interval`; `0` is supported. The first `#(...)` render can be empty or cached while tmux starts its asynchronous job, but successful event-driven updates should settle in roughly one second.

- `/reload` preserves state, generation, acknowledgement, and process incarnation while replacing old handlers.
- `/new`, `/resume`, and `/fork` clear the old context; no new record appears until the next accepted turn.
- A new Pi process in the same pane supersedes stale ownership without a false failure transition.
- Idle graceful quit removes state. Graceful quit during running or waiting records failure; graceful quit after a terminal result clears it.
- Abrupt death while running or waiting is rendered opportunistically as unread failure. An unread terminal result survives owner death.
- Closing a pane removes its state and acknowledgement; plugin load also cleans options for panes that no longer exist.

## Limits and safe degradation

One directly running Pi process per pane is supported. PID reuse can temporarily make a dead owner look live until pane cleanup or incarnation replacement. Pi and tmux must share the same host/server environment; nested tmux, SSH aggregation, and Windows are not supported.

Malformed, unknown, multiline, or inconsistent records are omitted without rendering raw state. Required renderer query failures produce an empty fragment and a short stderr diagnostic. Companion, acknowledgement, cleanup, and refresh failures are diagnosed on stderr but do not fail Pi, roll back persisted state, or start retry loops. A failed refresh may leave status cached until the next event.

Plugin and companion versions can be upgraded independently, but incompatible future state schemas may be omitted until both sides understand them.

## Verify

Run the complete automated acceptance entrypoint; it uses uniquely named disposable tmux servers and does not touch the live server selected by your current `TMUX` value:

```sh
./test/acceptance.sh
```

The complete MVP gate passed on `2026-07-24`:

| OS | tmux | Pi | Automated entrypoint | Real-Pi checklist |
| --- | --- | --- | --- | --- |
| Linux (Arch 7.1.4, x86_64) | 3.0 | 0.81.1 | Pass | Pass |
| Linux (Arch 7.1.4, x86_64) | 3.7b | 0.81.1 | Pass | Pass |
| macOS 26.4.1 (25E253, arm64) | 3.0 | 0.81.1 | Pass, final status timing 170ms | Pass |
| macOS 26.4.1 (25E253, arm64) | 3.7b | 0.81.1 | Pass, final status timing 178ms | Pass |

The final product-and-test content manifest has SHA-256 `d65d4071f11d4fe02edc390d7c39a8c0a99f18508b8a3054a899121ea618eb83`. Mac acceptance was rerun after applying the exact final timing-test patch (SHA-256 `814c337206543c7fd27414e7e46d6083dbd9d93620b577e74ee8cf9cb00e38f3`); both logs contain the revised attached-client timing sentinel, no `not ok`, and the final plugin-loading success. The real-Pi results are operator-attested manual checks.

### Real Pi TUI smoke checklist

> Turns, retries, and tool calls may use a configured model/API and may be billable. Run these checks manually with a provider whose cost you accept.

Record `uname -a`, `tmux -V`, `pi --version`, and the test date. Install the plugin and companion independently, place both fragments, set `status-interval` to `0`, and observe the Pi pane from another pane:

```sh
pane=%42 # replace with the Pi pane ID

tmux show-option -sqv "@tmux-agents-status-state-$pane"
tmux show-option -sqv "@tmux-agents-status-ack-$pane"
tmux display-message -p '#{E:@tmux-agents-status-window}'
tmux display-message -p '#{E:@tmux-agents-status-other-sessions}'
```

A valid record is `v1|PID|UUID|STATE|GENERATION`; running uses generation `-`. Verify every item:

- **Running and settlement:** an accepted turn shows `running` within roughly one second; successful, cancelled, and failed settlements produce the correct fresh terminal generation and glyph; the next turn returns to running and clears the prior acknowledgement.
- **Acknowledgement:** a result completed while viewing another pane is unread; visiting its pane copies that generation to the acknowledgement option and removes unread styling within roughly one second, without hiding the current-window terminal glyph.
- **Retry or continuation:** an automatic retry, compaction retry, or queued continuation remains running without an intermediate terminal alert.
- **Recoverable tool error:** a tool error that the same turn recovers from remains running until final settlement.
- **Reload:** `/reload` preserves state, generation, acknowledgement, and process incarnation while replacing handlers once.
- **Context changes:** `/new`, `/resume`, and `/fork` clear old state and acknowledgement; no new record appears before the next accepted turn.
- **Process replacement:** replacing a killed Pi process in the same pane clears or supersedes the old incarnation without storing another failure generation.
- **Graceful exit:** idle quit removes state; active quit records failure; quit after a terminal result clears it.
- **Abrupt death:** killing an active owner with `kill -9` leaves the stored record intact but renders unread failure; visiting acknowledges a `dead-UUID` generation and hides that virtual failure.
- **Pane cleanup:** closing the pane removes both state and acknowledgement options.

A compatibility lane passes only when every item above and `./test/acceptance.sh` pass on the same OS/tmux/Pi tuple.
