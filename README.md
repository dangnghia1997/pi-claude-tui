# pi-claude-tui

Claude Code visual identity for [pi](https://pi.dev): themes, welcome banner, status line, spinner, turn footer, and CC-style tool rendering — faithfully aligned against the Claude Code source, line by line.

## Install

From this checkout (pi loads a local package in place, without copying it):

```bash
cd ~/pi-claude-tui && bun install   # local packages keep their own dependency tree
pi install ~/pi-claude-tui
```

Once published:

```bash
pi install npm:pi-claude-tui
```

Try it without installing:

```bash
pi -e ~/pi-claude-tui
```

### Recommended setting

This extension draws its own welcome banner, so pi's built-in startup header
becomes redundant. Hide it in `~/.pi/agent/settings.json`:

```json
{ "quietStartup": true }
```

The banner is CC's bordered welcome box: the pi mark and session identity on
the left, `Extensions` and `Skills` listed under their own titles on the right.
On terminals narrower than ~76 columns it folds into a single box with the same
groups underneath.

## What you get

**2 themes** (`/themes` to switch, or use `/cc-theme` for the CC-only picker):

- `claude-code-dark` — matched key-by-key to CC's dark palette
- `claude-code-light` — matched key-by-key to CC's light palette

Both ship as truecolor hex values; pi downconverts them to the 256-color cube on terminals that do not report truecolor support.

**UI modules**:

- **Welcome banner** — CC's bordered box with the pi mark, model/cwd, and the loaded resources grouped under `Extensions` and `Skills` (both resolved for this session: extensions through pi's own package resolver, so disabled, missing, and untrusted-project entries stay out)
- **Status line** — model with its current thinking level (`thinking off` / `thinking high`, reasoning models only), cwd (with `~` shortening), git branch, a context-window progress bar, session cost and totals, painted from a coral/teal palette instead of CC's all-dim bar: bold coral model, teal branch, blue cost, muted chrome, and a four-step context ladder — lime below 50%, amber from 50%, orange from 75%, pink from 90%. Hues are darkened automatically on light themes, and cwd then branch are dropped first when the terminal is too narrow so the meter stays visible. When pi cannot vouch for the estimate (right after compaction) it shows `ctx ?` instead of a stale percentage.
- **Spinner** — CC's verb rotation with byline: elapsed time, token count, `esc to interrupt`
- **Turn footer** — per-request cost/duration summary, matching CC v2.1.234 behavior
- **Tool rendering** — CC-style tool rows (no background box), grouped consecutive calls with `⎿` continuation lines, CC-faithful diff rendering with syntax highlighting (shiki)
- **Thinking** — collapsed by default with CC's label treatment; `alt+t` to expand
- **Prompt editor** — CC's `❯` prompt pointer

**Commands**:

- `/cc-theme` — theme picker (CC themes only)
- `/cc-tools` — toggle CC-style tool rendering options
- `/cc-context` — context meter: `bar` (default) · `text` · `off`, and `width 4-40`; the choice persists
- `/cc-spinner` — spinner options

## Requirements

Runs inside pi (`@earendil-works/pi-coding-agent`); pi core packages are peer dependencies provided by the host. Developed and tested against pi 1.4.x. Every surface uses pi's public extension API; the only host-class touch is two guarded, idempotent method wrappers (`AssistantMessageComponent.render`, `InteractiveMode.showStatus`) that no-op if a future pi changes those shapes.

Runtime dependencies (`diff`, `@shikijs/cli`) live in the package's own `node_modules`. Pi does not install dependencies for a local package, so run `bun install` in this directory after checking out or updating it. This package is developed with bun (`bun.lock`; no npm lockfile is kept) — bun installs the pi host packages from `devDependencies` for typechecking and never ships them.

For development, `bun run typecheck` checks the extension sources against the pi type definitions (TypeScript + `@types/node` are dev-only and never shipped).

## Development

```bash
bun install          # runtime + dev dependencies (host packages come from devDependencies)
bun run typecheck    # tsc --noEmit, strict
bun run lint         # Biome: lint + format + import order (read-only, CI-safe)
bun run lint:fix     # same, applying Biome's safe fixes
bun run format       # formatting only
```

The package follows pi's conventional layout — `extensions/` (TypeScript sources, entry `extensions/index.ts`) and `themes/` (six JSON themes) — and pins both explicitly in the `pi` manifest of `package.json`, so only `extensions/index.ts` loads (the helper modules beside it are imported, never discovered as extensions).

Biome is the single tool for linting and formatting (`biome.json`); `bun run lint` is what CI and `prepublishOnly` run, so a publish never ships code that fails the typecheck or the linter. Intentional exceptions live in `biome.json`: ANSI escape regexes (`noControlCharactersInRegex`) and non-null assertions on array access (`noNonNullAssertion`) are off because this codebase matches terminal control sequences and indexes tuples under `strict` without `noUncheckedIndexedAccess`.

## License

MIT. Copyright (c) 2026 Alex Dang.
