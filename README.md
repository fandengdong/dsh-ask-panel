# dsh-ask-panel

**问一句 / Ask** — a right-column side panel for [dsh](https://github.com/deepseek-ai/deepseek-harness)
that answers questions about the work in progress **without interrupting it** and **without
polluting the main conversation**.

You ask from the panel, not the composer. Answers come from the context the agent already
holds — plus read-only lookups — and stream into a tab beside the conversation.

## What you get

- **Streaming answers** in a right-Sidebar tab, with a live three-line window showing the
  model's thinking (a high-effort reasoning model looks frozen without it)
- **Follow-up questions.** The thread continues, and because the seed is re-derived per
  question, a panel left open for an hour still answers about the *current* state
- **Markdown**, tables included
- **Reset (`⟲`)** drops the side context and marks the boundary in the log — it never erases
  what you already read
- **Reload-safe**: the panel's log is kept in browser storage per session
- **Read-only by default**: only `read`, `glob`, `grep` run. `write` runs too, but **only to
  create a file that does not exist**; a path this panel created stays editable, anything that
  was already on disk is refused

## Install

### 1. Install the package into a profile

```bash
dsh plugin --profile web add github:<you>/dsh-ask-panel   # git
dsh plugin --profile web add dsh-ask-panel                # registry
dsh plugin --profile web add /path/to/dsh-ask-panel       # local directory
```

No `pnpm`? Either install `pnpm`, or copy this package into
`$DSH_HOME/profiles/<profile>/node_modules/dsh-ask-panel/` and continue below.
This repository also ships `install.sh`, which copies the runtime files into
`$DSH_HOME/profiles/<profile>/plugins/ask-panel/` and writes the registration for you.

### 2. Register it

A package on disk is inert until the Loader is told to mount it. Add a row to the profile's
patch layer — or to the **HOME-level** layer `$DSH_HOME/cordis.patch.yml`, which every profile
inherits and which survives profile re-creation:

```yaml
- insert:
    - id: ask-panel
      name: dsh-ask-panel        # or the absolute path of host.js for a manual copy
      config:
        layoutWidth: false       # see "Caveats"
```

See `cordis.patch.yml.example`.

### 3. Restart, then refresh

A **host-side** change (this package's `host.js`) is only picked up by restarting `dsh`. A
**client-side** change (`client.js`) needs a browser refresh. When in doubt: restart, then
refresh.

## What it does with tools

| Tool | Policy |
|---|---|
| `read`, `glob`, `grep` | allowed |
| `write` | allowed **only when the target does not exist**; a file this panel created stays writable for the rest of the thread |
| everything else | refused with a reason the model can read and adapt to |

The refusal is decided **before dispatch** — `write` overwrites, so by the time a tool reports
anything the old bytes are gone. A refused create is retryable; an overwrite is not. The
ownership record is per session and in memory, and a `⟲` reset drops it, so those files become
read-only again.

## How it is built

| File | Role |
|---|---|
| `host.js` | The plugin face the Loader mounts: name, config, the forwarded-event allowlist, the command registration, and the width self-heal |
| `implementation.js` | The handler: request assembly, the read-only tool loop, the side thread, the live frames |
| `client.js` | A prebuilt lazy-CJS bundle registering the tab type, its body, and its live chip title |
| `patch-layout.js` | Optional, opt-in right-column-width persistence (see below) |

`host.js` re-imports `implementation.js` on every invocation, keyed by that file's mtime+size.
That is not decoration: a dsh host applies a profile's patch layer once and does **not**
re-import a row's module afterwards — not even when the row's specifier becomes a brand-new
file. Without the indirection, every host-side edit would need a restart; with it, edits are
picked up by the next question.

### Why `layoutWidth` patches a core package

The right column's width is per-page-load memory in `dsh-client-ui-layout`, and a plugin cannot
reach it: `ILayout`, the only cross-plugin layout face, exposes no width accessor. With
`layoutWidth: true` this plugin seeds that width from `localStorage` and saves it on drag, and
re-applies the two edits on every boot so a `dsh` upgrade does not silently revert them.

It is **off by default** because editing another installed package's bundle is not something a
plugin should do unless the person installing it asks. Anchors are exact and applied
all-or-nothing: a future layout bundle whose text shifted is reported as `skipped`, never
patched wrongly. A `.bak-btw` copy is kept beside the file.

## Caveats

1. **Transport.** The panel's input reaches the host through the command registry, because that
   is dsh's only client→host call path. Two consequences: `/ask` appears in the `/` menu
   (there is no way to register a hidden command), and live frames need the Remote assembly to
   forward one event — this plugin appends its entry to the **exported
   `API_REMOTE_FORWARDED_EVENTS` array** of `@deepseek-ai/dsh-api-remotes`, which is an internal
   detail rather than a documented plugin API. If upstream removes that export, the plugin fails
   loudly at load rather than degrading quietly.
2. **Streaming is best-effort.** The durable command result stays authoritative, so a dropped
   frame costs a little smoothness, never the answer.
3. **There is no plugin marketplace.** Distribution is npm or git; management is
   `dsh plugin --profile <p> …`, the GUI's Settings → Plugins inventory, and the patch layers.

## Development

Both suites run against an **installed** copy (they load the real bundle from the profile):

```bash
node test-ask-panel.mjs    # host half: 27 checks
node test-client.mjs       # client half: 21 checks
```

The installed plugin directory defaults to `$DSH_HOME/profiles/${DSH_PROFILE:-web}/plugins/ask-panel`
and can be overridden with `DSH_ASK_PANEL_DIR`. Nothing in either suite needs a live model, a
browser, or the network.

## License

MIT — see `LICENSE`.
