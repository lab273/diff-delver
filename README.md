# diff-delver

LLM-assisted diff organisation. An agent sorts your diff into logical sections and annotates it; you do the reviewing.

**Status:** early build. The project skeleton, its checks and the pure diff model are in place; nothing a reviewer can use yet. The design is in [docs/DESIGN.md](docs/DESIGN.md).

## Developer guidance

This applies to everyone who works on diff-delver, human or agent. `CLAUDE.md` and
`AGENTS.md` are symlinks to this file, so there is one copy.

What the tool does and why is in [docs/DESIGN.md](docs/DESIGN.md). How the code is
written, tested and committed is here.

### User experience comes first

Ease of use is the first principle of the project. It wins over features,
implementation convenience and the purity of the model. The commitments that
follow from it are in the design, under
[The first principle: it must be easy](docs/DESIGN.md#11-the-first-principle-it-must-be-easy).
Read them before building anything a person will see.

Before adding a feature, answer one question: what does a first-time user see, and
what do they do next?

### Requirements

- Node 26, the current LTS line. Newer LTS lines are fine.
- pnpm.
- git, and jj for the jj source and its tests.

`.nvmrc` pins the Node line and `package.json` pins pnpm (`packageManager`). After
cloning: `pnpm install`, then `pnpm exec playwright install chromium` once.

### Commands

| Command | What it does |
|---|---|
| `pnpm verify` | Everything a commit must pass, failing fast: Prettier check, ESLint, `svelte-check`, the Vitest suite, a production build, the Playwright journeys. Prints the time per step and the slowest tests. Fails if the whole run is over 90 seconds; slower machines set `VERIFY_BUDGET_SECONDS`. |
| `pnpm dev` | The app with live reload. |
| `pnpm build` | A production build into `build/`, run with `node build`. |
| `pnpm test` | Every Vitest test, core and integration. |
| `pnpm test:core` / `pnpm test:integration` | One Vitest layer. `pnpm test:watch` reruns on change. |
| `pnpm test:journeys` | A production build, then the Playwright journeys against it. |
| `pnpm lint` | ESLint, with warnings counted as failures. |
| `pnpm check` | `svelte-check`: types in TypeScript and Svelte files. |
| `pnpm format` | Rewrites files with Prettier. `pnpm format:check` only checks. |
| `pnpm fixtures:capture` | Rebuilds the diff fixture repositories with real git and records git's output as the core parser's fixtures. Run it after changing a fixture or the diff command. |

### Layout

| Path | Holds |
|---|---|
| `src/lib/core/` | Pure domain code: tiny types, the line model, coverage, export rendering. No Node built-ins (with or without `node:`), SvelteKit, Svelte, browser or server imports, and no clock, randomness, timers or environment: no `process`, `new Date()`, `Date.now`, `performance`, `crypto`, `Math.random` or `globalThis`; lint enforces this. Tests sit next to the code as `*.test.ts` and form the `core` Vitest project (250 ms per test, 5 seconds in all). |
| `src/lib/server/` | Daemon-side code: sources, the snapshot store, the database, MCP. |
| `src/routes/` | The UI and the HTTP routes. |
| `src/**/*.test.ts` outside core, and `scripts/**/*.test.ts` | The `integration` Vitest project (3 seconds per test). `src/lib/scale.test.ts` measures the pure diff model at full size here, for the larger budget. |
| `tests/journeys/` | One Playwright file per journey, `j<N>-<name>.journey.ts`, with the journey's name as its `describe`. They run in Chromium against one production build on a free port, 20 seconds per test. |
| `src/lib/core/diff/` | The diff model (DESIGN 4): reading git's diff output, change units, assignment, coverage, slices and the agent-facing diff text. Import it from `#lib/core/diff/index.ts`, its one entry point. `fixtures/` holds git output recorded by `pnpm fixtures:capture`; never edit it by hand. |
| `src/lib/core/range-set.ts`, `range-map.ts` | Sets of whole numbers and maps from them, stored as intervals. Line assignments are stored in them, and reviewed marks should be too. |
| `src/lib/server/git/` | Running git. `run-git.ts` runs one command, isolated from the machine's git config, and returns typed errors; everything that calls git goes through it. `read-diff.ts` reads the diff between two trees with the one fixed diff command, run in an empty repository that borrows the reviewed one's objects, so none of its config or attributes apply. |
| `tests/support/` | Shared test helpers. `accessibility.ts` scans the current screen with axe; every journey calls it on every screen it reaches. `git-repo.ts` builds real repositories with real git, with a fixed identity and dates. `fixture-repos.ts` gives each integration test its own copy of a named fixture repository (`defineFixture`, `useFixture`), built once per run, or a fresh empty one (`emptyRepo`). `diff-fixtures.ts` defines the repositories with every awkward kind of change. `synthetic-diff.ts` writes diff output for property and size tests, and is pure, so core tests may use it. `stopwatch.ts` is the real clock, for the size tests that measure elapsed time. |
| `scripts/verify.ts` | The `pnpm verify` runner. |
| `scripts/capture-diff-fixtures.ts` | The `pnpm fixtures:capture` script. |
| `scripts/ci-commits.sh` | Lists the commits a push must verify, for CI, and splits them into jobs. Tested by `scripts/ci-commits.test.ts`, in the `integration` project. |
| `.github/workflows/verify.yml` | CI: `pnpm verify` on every commit of every push to `main`, including every rewritten commit of a force push. |
| `.beads/` | The beads issue tracker's settings. The issue database itself is not in git; it syncs through `bd dolt push` and `bd dolt pull`. After cloning, `bd bootstrap` fetches it. |

**Tiny-type files.** A tiny type and its parse function live in their own file
named `<name>.tiny.ts` under `src/lib/core/`, for example `line-number.tiny.ts`.
Those are the only files where lint allows a type assertion (`as`) or a type
predicate (`v is T`, `asserts v is T`), since either can forge a tiny type. The
`Tiny` brand itself is in `src/lib/core/tiny.ts` and `Result` in
`src/lib/core/result.ts`.
Comments cannot switch lint rules off (`noInlineConfig`); fix the code instead.

### How we work

- **Straight to `main`.** No feature branches and no pull requests. Work lands as
  a series of small commits on `main`.
- **Reviewed before it is pushed.** Work is done in packages: a handful of commits
  with one purpose. When a package is finished and passes `pnpm verify`, a separate
  review agent that did not write it reviews its commits against this guidance and
  the design. Findings are fixed in further commits, each passing `pnpm verify`.
  Only then is the package pushed. Nothing unreviewed reaches `origin`.
- **Every commit stands alone.** Each commit compiles, passes formatting, linting
  and type checks, and passes the whole test suite. Checking out any commit on
  `main` gives working software. There are no "fix the build" or work-in-progress
  commits.
- **One command decides.** `pnpm verify` runs everything a commit must pass:
  format check, lint, `svelte-check`, the Vitest suite, a production build and
  the Playwright journeys. Run it before every commit.
- **CI is the backstop, per commit.** CI runs `pnpm verify` on every commit that
  reaches `main`, not only the newest, so a commit that fails on its own is found
  even when a later one repairs it.
- **If `main` breaks, that comes first.** Fix it or revert the commit before
  anything else.
- **Speed is a feature of the suite.** A change that makes the suite slower needs
  the same justification as one that makes the product slower. The budgets are
  under [Testing](#testing).
- **Not published to npm.** The package is private and stays that way. Never run
  a publish command and never reserve the name on a registry.
- **Work is tracked in beads.** See [Tracking work](#tracking-work).

The repository is used with both git and jj, and jj does not run git hooks, so the
check cannot rely on a pre-commit hook alone. `pnpm verify` and per-commit CI are
the mechanism.

### Tracking work

Issues and tasks live in [beads](https://beads.gascity.com/) (`bd`), not in
documents, code comments or an agent's memory. If work is owed, found, blocked or
decided, it gets a bead.

| Command | What it does |
|---|---|
| `bd ready` | What can be worked on now: open, with nothing blocking it |
| `bd show <id>` | One issue, with its notes and dependencies |
| `bd create "Title" -t task -p 2 -d "…"` | A new issue. Types include `task`, `bug`, `epic` and `decision`; add `--parent <epic>` and `--deps <id>` |
| `bd update <id> --claim` | Take an issue and mark it in progress |
| `bd note <id> "…"` | Add what was learned or decided |
| `bd close <id> --reason "…"` | Finish it, naming the commits |
| `bd dolt push` | Publish the issue data (see the rules below first) |

How we use it:

- One epic per build step in the design, plus one for process and tooling. Tasks
  hang off an epic and depend on what must come first, so `bd ready` is the queue.
- Claim an issue before starting it and close it with the commit ids when it is
  done and pushed.
- File what you find while working on something else as a new issue instead of
  fixing it in passing or leaving a comment in the code.
- A question only a person can answer gets the `needs-human` label.

**Nothing personal or sensitive goes in a bead.** Issue data is public: it is
pushed to `refs/dolt/data` on `origin`, and beads keeps the full history of every
edit, so a later correction does not remove what was written.

- No personal names, personal email addresses, usernames or home-directory paths.
  Refer to roles: "the project owner", "the reviewer".
- No secrets, tokens, keys or passwords, and nothing from a private repository or
  a customer.
- beads copies the git identity into every issue (`user.email` into `owner`,
  `user.name` into `created_by`). Always run it with the agent identity:

  ```
  export BEADS_ACTOR=plog-agents GIT_AUTHOR_EMAIL=plog-agents@lab273.com
  ```

- Before `bd dolt push`, export the data (`bd export --all -o <file>`) and check
  it for email addresses and names. If something personal has got in, do not
  push; say so, because removing it means rebuilding the database.

beads' usage metrics are switched off on the project's machines
(`bd config set metrics.disabled true`).

### Tiny types

Every domain value has its own type. No bare `string` or `number` crosses a module
boundary.

```ts
declare const brand: unique symbol;
type Tiny<T, Name extends string> = T & { readonly [brand]: Name };

export type ReportId   = Tiny<string, "ReportId">;
export type ReviewNo   = Tiny<number, "ReviewNo">;     // 1, 2, 3 within a report
export type TreeId     = Tiny<string, "TreeId">;       // git tree hash
export type RepoPath   = Tiny<string, "RepoPath">;     // path inside a tree
export type LineNumber = Tiny<number, "LineNumber">;   // 1-based
export type ByteSize   = Tiny<number, "ByteSize">;
export type AgentMarkdown = Tiny<string, "AgentMarkdown">; // unsanitised
export type SafeHtml      = Tiny<string, "SafeHtml">;      // sanitised, renderable

export function parseLineNumber(n: number): Result<LineNumber, InvalidLineNumber>;
```

- A tiny type is made only by its parse function, which checks the value. Code
  that holds a `LineNumber` knows it is a positive integer.
- Parsing happens once, at the edge: MCP tool input, HTTP request, database row,
  git output, CLI argument.
- Compound values are small read-only objects built from tiny types: `LineRange`,
  `Anchor`, `SliceKey`, `SnapshotRef`.
- The types carry the safety rules. Agent text is `AgentMarkdown` and can only
  reach the page by passing through the sanitiser, which returns `SafeHtml`.
  A `Side` is `"old" | "new"`, never a boolean.

Expected to exist from the start: ids for report, revision, snapshot, review,
section, thread, message and request; `TreeId`, `BlobId`, `CommitId`; `RepoPath`,
`Side`, `LineNumber`, `HunkId`; `Role`, `Bucket`; `ByteSize`, `Timestamp`;
`AgentMarkdown`, `HumanMarkdown`, `SafeHtml`; `DaemonToken`.

### Strong typing

- TypeScript `strict`, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. No `any`. No `!`. `as` is allowed only inside a
  tiny type's parse function.
- One schema per boundary, written once with Zod, and the static type is inferred
  from it. The same schema validates an MCP tool's input and produces
  the tool's published JSON schema.
- Variants are discriminated unions: `SourceSpec`, `Bucket`, `ThreadKind`,
  `RequestKind`, `ReportEvent`. Every `switch` over one is exhaustive, enforced
  with a `never` check.
- Expected failures are values, not exceptions: `Result<T, E>` with a typed error
  union such as `SourceNotFound | NotARepository | AuthRequired`.
- Every error variant must map to a message for the reviewer: what happened and
  what to do next. The mapping is an exhaustive `switch`, so adding an error
  without writing its message does not compile.
- Database rows are parsed into domain types by one module per table. Nothing else
  sees a raw row.
- The UI and the server share one typed API client. A route's response type is the
  type the page receives.

### Testing

**Journeys.** The design lists the
[user journeys](docs/DESIGN.md#10-user-journeys). Each one has one end-to-end test
with the same name. A feature is done when its journey passes. New behaviour starts
with a new or changed journey.

**Real tests.** Tests use the real thing wherever it can run on a developer's
machine.

| Real | How |
|---|---|
| git and jj | Fixture builders run the actual commands to create repositories in temporary directories. |
| SQLite and the snapshot store | Real files in a temporary data directory. |
| The daemon | Started on a free port and called over HTTP. |
| The agent | The MCP SDK's client, connected through the real stdio shim, running a scripted categorisation. |
| The browser | Playwright, including real clipboard reads. |

Stand-ins are used only where the real thing is outside the machine:

- **GitHub**: a local git remote that serves `refs/pull/N/head`, plus a small local
  HTTP server for the handful of REST calls. A separate opt-in suite runs against
  a public fixture repository.
- **Time**: a `Clock` passed in, with a settable implementation for tests.

No module mocking, and no fake git, file system or database.

**Three layers.**

1. **Core**, pure and fast: the line model, coverage arithmetic, carry-over
   matching, export rendering. Property-based tests hold the invariants, chiefly
   that every change line is in exactly one bucket after any sequence of `assign`
   calls and any diff update.
2. **Integration**: each source against real repositories, the store, the MCP
   tools.
3. **Journeys**: the end-to-end tests above.

**Keeping it fast.** Every commit runs the whole suite, so a slow suite slows
every change. Real tests and fast tests are both required; these are the means of
having both:

- Most logic lives in the pure core, where a test takes milliseconds. The slower
  layers check wiring, not rules.
- Fixture repositories are built once per run, keyed by the script that builds
  them, and copied for each test.
- Nothing is shared: no fixed ports, no global state, a temporary data directory
  per test. Every test can run in parallel with every other.
- The daemon starts in-process and takes its data directory as an argument, so a
  test gets its own in a few milliseconds.
- Journey tests run against one production build, in one browser, with a fresh
  browser context per test.
- No sleeps. Tests wait on events or conditions and take time from the `Clock`.
- Slow extras stay out of the per-commit run: the live GitHub suite, other
  browsers and the large-repository measurements. They run on a schedule and
  before a release.

Starting budgets, to be tightened once there is code to measure:

| What | Budget |
|---|---|
| The whole per-commit check on a laptop | 90 seconds |
| All core tests | 5 seconds |
| One core test | 250 ms |
| One integration test | 3 seconds |
| One journey test | 20 seconds |

A test over its budget fails. The run prints its total time and its slowest
tests, so a slowdown is seen in the commit that causes it.

### Checking the experience

The first principle is checked, not assumed.

- **Journey tests read the page as a person does.** They find controls by their
  visible label and role, not by hidden test ids. A button with an unclear or
  missing label fails the test.
- **The first-run journey (J0) has a budget.** From a machine with only Node and
  git, to reading a diff: one command. From there to a finished review on the
  clipboard, using only what the page shows.
- **Accessibility is automated** in every journey: keyboard-only completion and
  an automated accessibility scan of each screen.
- **Speed has budgets** that fail the build when exceeded, measured on a large
  fixture diff: time to first readable content, and time to move to the next
  file.
- **Each build step ends with a cold walkthrough.** Someone who has not used that
  step's features tries its journeys without help. Whatever they stumble on is
  fixed or cut before the next step starts.
- **Every journey step has a committed screenshot.** Each step of a journey saves
  a named screenshot into the repository, so the interface can be inspected
  without running it and a change to it shows up as a changed image in the
  commit. `pnpm verify` fails when a step no longer matches its image; a commit
  that changes the interface regenerates the images it affects.
- **Journeys are deterministic.** The same commit produces the same screenshots
  on every run and every machine of the reference platform. What could vary is
  fixed at its source, never masked or tolerated: fonts are bundled with the app,
  the viewport, locale, timezone and colour scheme are set, animations are off,
  and time, ids and fixture dates are supplied by the test.

### Tooling

The project is created and extended with the Svelte CLI (`sv`), so its setup stays
the one the Svelte team maintains.

| Add-on | For |
|---|---|
| `sveltekit-adapter` | The Node adapter, which the daemon runs on |
| `eslint` | Linting |
| `prettier` | Formatting |
| `vitest` | Core and integration tests |
| `playwright` | Journey tests |

```
pnpm dlx sv add prettier eslint vitest playwright sveltekit-adapter
```

**Linting** uses the official ESLint add-on
(<https://svelte.dev/docs/cli/eslint>). It installs ESLint with
`eslint-plugin-svelte`, writes `eslint.config.js`, updates
`.vscode/extensions.json`, and configures itself for TypeScript and Prettier.

**Formatting** uses the official Prettier add-on. Prettier owns layout and ESLint
owns correctness, so the two never argue about the same line.

On top of what the add-on generates, the lint config enforces the rules under
[Strong typing](#strong-typing) that the compiler alone does not:

- no `any` and no non-null `!`
- type assertions (`as`) only in the files that define tiny types
- exhaustive `switch` over union types
- type-aware rules switched on, so unhandled promises and unsafe values are caught

Formatting, linting, `svelte-check` and the tests all run in CI, and any of them
failing fails the build.

## Licence

[GNU Affero General Public License v3](LICENSE).
