# diff delver: developer guidance

This applies to everyone who works on diff-delver, human or agent. `CLAUDE.md` and
`AGENTS.md`, at the top of the repository, are symlinks to this file, so there is one
copy.

There are three documents, and nothing is said in two of them:

| Document | For | Holds |
|---|---|---|
| [README.md](../README.md) | Someone who wants to use diff delver, or build it | What it is, how to use it, and how to build it, in plain words and briefly |
| [docs/DESIGN.md](DESIGN.md) | Someone deciding what it should do | What the tool does and why |
| This file | Someone changing it | How the code is laid out, written, tested, committed and released |

Keep the README short. It shows the main ways the tool is used, and what does not
work yet; detail belongs here or in the design. Its pictures are the journeys'
committed screenshots (`tests/journeys/screenshots/`), in both themes, never images
made for it, so they change with the interface. What is built so far, and what is
not, is in the README under [What works today](../README.md#what-works-today).
`scripts/documents.test.ts` fails when a document links to a file or a heading that
is not there, or the README shows a picture that is not a journey's, or shows it in
the wrong theme.

## User experience comes first

Ease of use is the first principle of the project. It wins over features,
implementation convenience and the purity of the model. The commitments that
follow from it are in the design, under
[The first principle: it must be easy](DESIGN.md#11-the-first-principle-it-must-be-easy).
Read them before building anything a person will see.

Before adding a feature, answer one question: what does a first-time user see, and
what do they do next?

## Requirements

- Node 26, the current LTS line. Newer LTS lines are fine.
- pnpm.
- git 2.45 or newer, and jj for the jj source and its tests. diff delver checks the
  git version when it first runs git and says plainly if it is too old.
- beads (`bd`), the issue tracker, 1.3.4 or newer. It is needed only to track work, not to build or test.

Running diff delver, rather than working on it, needs only Node 26 and git (see
[Use it](../README.md#use-it)): a release is a tarball of the build with no dependencies.

`.nvmrc` pins the Node line and `package.json` pins pnpm (`packageManager`). After
cloning: `pnpm install`, then `pnpm exec playwright install chromium` once. `pnpm
install` also builds the app and the command (the `prepare` script), as `npx
github:` does when it fetches diff delver.

## Commands

| Command | What it does |
|---|---|
| `pnpm verify` | Everything a commit must pass, failing fast: Prettier check, ESLint, `svelte-check`, a production build, the Vitest suite (whose daemon and command tests use the build), the Playwright journeys with their committed screenshots, and the viewer's speed on a large diff (`tests/speed/`). Prints the time per step, the slowest tests, and a warning for each test over the time guidance under [Testing](#testing) and for a run over two minutes (`VERIFY_WARN_AFTER_SECONDS` changes that), and the notices tests record (`tests/support/test-notices.ts`), such as an agent trial recorded with an older skill; neither time nor a notice fails it. |
| `pnpm dev` | The app with live reload, on the data folder in `DIFF_DELVER_DATA_DIRECTORY` or this machine's default, without the daemon's checks: for working on the pages. |
| `pnpm build` | A production build into `build/`: the app (`vite build`, the Node adapter's `build/handler.js`), then the command (`vite.cli.config.ts`, `build/cli/diff-delver.js`). `node bin/diff-delver.js` runs it. The integration tests that run the command make it themselves when it is older than its sources. Its version is the package version marked `-dev` and a hash of the code; with `DIFF_DELVER_RELEASE_VERSION` set, as the release workflow sets it, the release's version instead. It also records the commit it was built from, when that was made and whether what the hash is made of had changes not committed (`+ changes`; an edited document or a stray file is none), from git without its optional locks, or nothing where git or the repository is not there (`buildIdentity` in `src/lib/server/version.ts`); `--version` names its short commit after the version (`core/cli/version-line.ts`, which every reader of that line uses), as does the daemon's "started" line in its log. |
| `pnpm test` | Every Vitest test, core and integration. |
| `pnpm test:core` / `pnpm test:integration` | One Vitest layer. `pnpm test:watch` reruns on change. |
| `pnpm test:journeys` | A production build, then the Playwright journeys against it, with the journey helper's own tests and the viewer's speed on a large diff. |
| `pnpm journeys:update` | After an intended change to the interface: runs every journey and rewrites the screenshots whose pixels changed, adds new ones and removes ones no step makes any more, then lists them. Look at them and commit them with the change. Linux only. |
| `pnpm journeys:repeat [runs]` | Checks that the journeys are deterministic: runs every journey many times at once (20 by default) and reports whether every screenshot came out identical, in pixels and in bytes, and equal to the committed one. Not part of `pnpm verify`. |
| `pnpm lint` | ESLint, with warnings counted as failures. |
| `pnpm check` | `svelte-check`: types in TypeScript and Svelte files. |
| `pnpm format` | Rewrites files with Prettier. `pnpm format:check` only checks. |
| `pnpm bd <arguments>` | beads' `bd`, with the agent identity set. `pnpm bd push` flags likely personal data before publishing. See [Tracking work](#tracking-work). |
| `pnpm release:package [--version <release>] [--out <folder>]` | Packs the build already in `build/` into `release/diff-delver.tgz`, with its checksum and release notes: bin, the build without source maps, the licence, the README and a package.json with no scripts or dependencies, still private. With `--version`, refuses a build that reports another. Never builds and never publishes. See [Releasing](#releasing). |
| `pnpm release:check [<tarball>] [--version <release>]` | Proves a packed package works: installs it with `npx` from a local address that redirects as GitHub's does, in a fresh folder with only Node, npm, git and a shell, no registry and nothing of the machine's, asks its version, opens a diff with `--no-open` and asks its page, asks `diff-delver mcp` for its tools over standard input, and stops it. Says how long the first run took and what it downloaded. |
| `pnpm fixtures:capture` | Rebuilds the diff fixture repositories with real git and records git's output as the core parser's fixtures. Run it after changing a fixture or the diff command. |
| `pnpm mcp:surface` | Writes what an agent sees of the MCP server, its name, title, capabilities and instructions and every tool's name, description and input schema, into `src/lib/server/mcp/fixtures/agent-surface.json`, after an intended change to them. A test fails until it is written again; read the change and commit it with the change, as with a screenshot. |
| `pnpm trials:run [--agent claude\|codex\|scripted] [--fixture shop\|ledger] [--without-skill]` | One agent trial: a real coding agent, headless, sorts a fixture's diff through our MCP server, written to `tests/agent-trials/recordings/`. Run by hand only; `claude` and `codex` spend the project owner's subscription. See [Agent trials](#agent-trials). |
| `pnpm fixtures:old-database` | Rebuilds the data folder an earlier diff delver wrote (`src/lib/server/reports/fixtures/before-file-units/`), by running that version's code from git history, so it needs a clone with history. Run it only to change what the fixture holds. |

## Layout

| Path | Holds |
|---|---|
| `src/lib/core/` | Pure domain code: tiny types, the line model, coverage, export rendering. No Node built-ins (with or without `node:`), SvelteKit, Svelte, browser or server imports, and no clock, randomness, timers or environment: no `process`, `new Date()`, `Date.now`, `Temporal.Now`, `performance`, `crypto`, `Math.random`, `globalThis`, `import.meta` or `Intl`, and no method whose result depends on the locale or timezone (`toLocaleString`, `localeCompare`, local-time `Date` getters, a `Date` turned into text); lint enforces this. Tests sit next to the code as `*.test.ts` and form the `core` Vitest project. |
| `src/lib/server/` | Daemon-side code: sources, the snapshot store, the database, the daemon, the command, MCP. |
| `src/routes/` | The pages (home; `start`, the start page, which shows the start page's choice, the few sources the no-argument start finds equally likely, or why there is nothing to review, and links to the choose page; `choose`, the choose page, where a person picks commits or a whole branch of a repository to review, or, for a repository on GitHub, one of its open pull requests; `diffs/[id]` for one diff). These two names are used throughout: the start page's choice is a short list of sources, the choose page a repository's branches and commits and the HTTP API under `api/`: a diff's frame (`api/diffs/[id]`, everything but the code, each part with its step when its section has a reading order, of its newest version or the one a page shows), one part's lines (`part`), lines of a file to open (`lines`), one side of an image as it is, for an `<img>`, with the content type its bytes have and in a sandbox, so an SVG runs nothing (`image`), the colours of lines by language (`colours`), a search of the diff, part by part (`search`) marking reviewed on the version shown (`reviewed`), the reviewer's questions for the agent asked, cancelled or promoted (`requests`, a POST needing a browser that may write the draft; the questions themselves, and whether an agent is connected, come with the frame), the agent's overview or a section's summary read, as the version shown has it (`read`), the overall review of the draft, read with the draft's comments and saved on the words the page read (`overall`), the agent's notes dismissed, promoted into the draft or brought back (`notes`, a POST needing a browser that may write the draft; the notes themselves come with the frame), finishing the draft as the next review, for a pull request's Delve posting it to GitHub when asked, and the finished reviews with the text each handed over and where each was posted (`reviews`, and `reviews/preview`, what finishing now would hand over and, for a pull request's Delve, what posting it would put on GitHub), how to have an agent sort it (`agent`: what to copy for this daemon and this Delve, asked for when the instructions are opened, never with the page), besides opening, checking, updating, closing and deleting, and opening a page in a window of the person's browser that may write their drafts (`api/review-window`, a POST any of the daemon's pages may make, answered only with what became of asking: opened, no browser to ask, or held back because one was opened a moment ago); a repository's branches, when it last fetched and its remote on GitHub, if any (`api/history`), a branch's commits a page at a time (`commits`), the size of a run of them (`size`), asking its remotes what they have (`check`, a POST, only when the person presses its button) and its open pull requests on GitHub (`pull-requests`, a POST, only when the person opens the list); and the person's settings (`api/settings`). Pages load through the typed client (`#lib/ui/client.ts`) and say every error in place, in plain words. The layout's header is on every page: the name, a link to the list of Delves ("Your Delves") and, quietly at its right end, which build the running daemon was made from, its release and commit and how long ago that commit was made by the daemon's clock (`core/build-identity.ts`), shortened and then put away on a narrow screen; the daemon is given its build (`DaemonOptions.build`), which journeys fix. On a Delve's page the layout also draws the panel that opens another Delve (`DelveSwitcherPanel.svelte`), and it gives each Delve a page of its own, so nothing of one Delve's page is carried to the next. `src/hooks.server.ts` hands each request the daemon serving it (`locals.daemon`), and logs errors nothing expected. Every page is sent with a Content-Security-Policy (`csp` in `vite.config.ts`): nothing loads from outside the daemon and only its own scripts run. |
| `src/lib/api/` | The HTTP API's one Zod schema per request and response (`schemas.ts`), shared by the routes, the pages, the command and tests, and the one typed client (`client.ts`), whose calls return a `Result` with an `ApiError` that has a message for the reviewer. Tiny types are parsed here, at the edge. |
| `src/lib/server/api/` | The routes' half of the API: the report service's results as the API's values and its errors as HTTP answers with their messages (`present.ts`), reading a request's body and id (`request.ts`), the repositories of the diffs listed, with whether each one's folder is still there (`repositories.ts`), a stored comment as the API gives it (`comments.ts`), how to have an agent sort a Delve, with whether its repository's folder is still there (`agent-sorting.ts`), whether a request's browser may write the person's drafts, with what a browser that may not is told (`review-session.ts`), and a finished review as the API gives it (`reviews.ts`). |
| `src/lib/server/daemon/` | The daemon (DESIGN 3, 9), imported by file. `daemon.ts` starts one for a data folder: the report service, a server on 127.0.0.1 with the request gate in front of the app (`http-server.ts`), on the port it is given when it can have it (`preferredPort`: the command gives `STABLE_PORT`, 12321, for the machine's default data folder, by the rule in `core/daemon/stable-port.ts`; tests give one they found free, never 12321) and otherwise on a free one, which it says once, with why, in its log and through the command (`portNotice`); a port in use is tried again for `PREFERRED_PORT_TRIES_FOR_MS` first, though a daemon it replaces closes its server before it lets its lockfile go, so its port is free by then; the lock (`lockfile.ts`: `daemon.lock` with port, process, token and version, made whole or not at all, replaced when stale, and checked every few seconds: a daemon whose lockfile is gone or another's stops, since nothing could reach it), the removal of snapshots left behind, the counting of binary files an earlier diff delver did not count (`countBinaryFiles`), once it is serving, and, from the same repeating check as the lock and by its clock, tidying the stores every `TIDY_STORES_EVERY_MS`; it takes its `Clock` and `IdSource` as arguments, which only tests and journeys fix. What it has to say, its own lines, the report service's, the app's unexpected errors, its start with its version and its stop with why (`core/daemon/stop-reason.ts`: `diff-delver stop`, another copy replacing it, which says its version in the stop request, a signal, or its lockfile gone) and, started in the background, why it could not start, goes through its log (`daemon-log.ts`), standard error, which is `daemon.log` when the command started it, each line beginning with when it was written, in UTC to the second, by its clock (`core/daemon/log-line.ts`); what the command prints to the person has no time. Its starter also tells it what it knows of the machine (`MachineFacts`: the file the command was run by, the machine's default data folder and the person's home folder), from which it works out how an agent is given this very daemon (`agentSetupOf`); the command gives all three (`serve` in `main.ts`), and a daemon told nothing names its data folder and gives the release's command. It remembers, in memory only, the agents heard from on `/mcp` (`core/daemon/agent-activity.ts`). `context.ts` is where the app's routes find their daemon, by port. `launcher.ts` is how the command finds the daemon of its data folder, starts one in the background (`diff-delver serve`, logging to `daemon.log`, its ready signal carrying what it said of its port) or replaces one of an older release or another build, saying whether the new one is at the old one's port, so its pages offer to reload, and uses one of a newer release as it is, as it does any running daemon when the data folder's database has a migration this copy does not know (`newestMigrationIn`, which opens the database read-only), since its own daemon would refuse it, and never replaces a daemon the same call has just started; there is no `--port`; `probe.ts` tells a live daemon from a stale lockfile. `browser-access.ts` keeps what lets a browser write the person's drafts in the data folder (`browser-access.json`, made by the first daemon and replaced unless it is a plain file of ours, the person's own, that nobody else may read), so a browser keeps review access when the daemon restarts; every other token and every entry code is one daemon's. A daemon reads it once, when it starts: to take review access from every browser, stop the daemon, delete the file and start diff delver again. `http-server.ts` hands `/mcp` to the MCP server (`#lib/server/mcp/`) instead of the app. `app-handler.ts` loads the app from the build (`#build/handler.js`, typed by `src/build-handler.d.ts`). `development.ts` is `pnpm dev`'s. |
| `src/lib/server/cli/` | The `diff-delver` command: `main.ts` (what each command does and prints), `outcome.ts` (what opening something, or `diff-delver choose`, prints and which page it opens, if any: none for a pull request that cannot be opened or has nothing to review, since no page would say why; shared with the journeys), `open-browser.ts`, `mcp-shim.ts` (`diff-delver mcp`: finds or starts the daemon as the command does and passes stdio MCP to its `/mcp` with the token, the folder it was started in and whether to open the browser in headers; finds the daemon again and sends a message again when its daemon stopped or was replaced, so the agent never sees it, comparing it then with the command on disk (`versionOnDisk`), which may have been rebuilt since the shim started; standard output is only the protocol), and `run.ts`, the build's entry. `bin/diff-delver.js`, plain JavaScript, checks the Node version and runs the build. |
| `src/lib/core/daemon/request-gate.ts`, `entry-codes.ts`, `review-windows.ts`, `stable-port.ts`, `core/cli/command-line.ts` | Pure: which port a daemon tries first, `STABLE_PORT` for the machine's default data folder and any free one for another, and what it says when it could not have it; which requests the daemon serves (`Host`, `Origin` for changes, a single-use entry code from the address, the token in a cookie or `Authorization`, and for `/mcp` only in `Authorization`) and what a refusal says; the entry codes a daemon has given out, each good once, at most `MOST_ENTRY_CODES_KEPT` unused kept, and each for one grant, to read and tick (`view`) or also to write the person's drafts (`review`), so the token is never on a command line; how often a window that may write drafts is asked of the system, at most one every few seconds by the daemon's clock, whoever asks; reading the command line, its errors and its help. |
| `src/lib/core/agent-setup/`, `core/daemon/agent-activity.ts` | Having an agent sort a Delve, pure. `agent-server.ts`: which copy of diff delver a daemon is (a release, or a build that is no release, run by the file that started it with the Node the daemon runs on) and the command that gives an agent that copy on that data folder, as Claude Code's `claude mcp add`, as Codex's `config.toml` entry and as the plain command for any other agent; `--data-directory` is in it only when the folder is not the machine's default. `shell-words.ts`: words quoted for a POSIX shell, so any folder pastes as itself, and a path under the home folder written from `~`. `sort-request.ts`: the sentence a person pastes to their agent, which names the report by id, says not to create another and where to begin, and the `cd` to the Delve's repository. `text-to-copy.tiny.ts`: the label for text written to be pasted elsewhere. `agent-activity.ts`: what a daemon remembers of agents, bounded and by its clock (when a server started in each folder last sent a message, with that folder's links resolved by the daemon, `src/lib/server/real-folder.ts`, so a link to a repository counts as the repository; when a tool call that was answered last named each report), and the words for it, which say when something happened and never that an agent is connected now, since `/mcp` keeps no session; and which Delves an agent listens to (`agentListening`, held by the report service): one whose `wait_for_requests` call is open or ended less than `LISTENING_LINGERS_MS` ago, the one thing a page calls "Agent connected". |
| `src/lib/ui/` | What the pages share: the client for pages, one Delve as a list shows it (`DelveEntry.svelte`, drawn by the list of Delves and by the panel, so a Delve is described in one way, with the mark for something written and not saved yet, a comment or the overall review), the panel that opens another Delve (`DelveSwitcherPanel.svelte`: a dialog, "Open another Delve", that asks for the list of Delves when it is opened, never with the page, lists the others as links, in a part of its own that scrolls, with a box to find one by name past a handful, and keeps under it the choose page for this Delve's repository, the list of all Delves and Close, and is put away when a link in it is followed; `delve-switcher.svelte.ts` is whether it is open, handed from the layout to a Delve's page as context, which opens it from "Open another" in its rail and with `d`), the way to open something new in a repository diff delver knows (`ChooseLink.svelte`: a link to the choose page for its folder, or a sentence in its place when the folder is no longer there; another kind of source, such as a pull request, would be offered beside it), what a page says when its browser was let in by a link and so may not write comments or delete, with the one button that turns them on (`ReviewAccess.svelte`), what a page says when the daemon answering it now runs another version than the one that served it, asked when the person comes back to the page and every minute, with a button that reloads it, which asks first, as leaving does, when words are not saved (`DaemonReplaced.svelte`, drawn by the layout, with the words in `core/cli/replaced-daemon.ts`), a diff's size as GitHub shows it, with the lines that are tests apart when it is given them (`DiffSize.svelte`), text from a repository such as a branch's name with what cannot be seen written out (`VisibleText.svelte`), notices, the dialog that asks before deleting, the copyable command, text to copy shown exactly as it will be pasted, line by line with what cannot be seen written out (`CopyText.svelte`), the command a newcomer is shown (`run-command.ts`), keys pressed before a page's scripts have run that only its scripts would act on (its shortcuts, and Enter or Space on a button, link or tick box as the browser would), kept by a small script in the page's head, written into `src/app.html` by `src/hooks.server.ts` from the pure rule, and done once the page is ready, which it marks with `data-ready` on the root element, or let go if the page fails to start or a few seconds pass (`early-input.ts`), and which checks for changes a diff's page starts and which answers it takes, giving up on one that goes unanswered for a minute so the next can start (`change-checks.ts`, with its timer passed in). `viewer/` is the diff viewer: `viewer.svelte.ts` holds what the page holds while a person reads, taking its API client as an argument (parts in reading order, what is open, lines fetched a part at a time when near the screen and unchanged lines a step at a time, the filter, where the person is (a part, or the agent's overview or a summary the page took them to, read once they move on from it with `n` or `r`), the agent's texts read, by their words, ticks on the version shown, what another page on the same diff ticked, fetched again in place when the page comes back into view, now and then, and when a tick's answer disagrees with what the page holds, and drawing a large diff a batch a frame after its first screen, fetching parts' lines at most `PART_REQUESTS_AT_ONCE` at a time, from `requests.ts`); `Part.svelte` is one file's part with its tick (in a section with a reading order, one step of it, with "Step 2 of 3" and the agent's note on the step above its lines), `ProgressBar.svelte` how far a review has got, as a bar, `PartLines.svelte` its lines as a unified diff or side by side, each line's number the button that opens the small menu under its lines, Comment, Flag or Ask (`c`, `f` and `q` on it do each at once, through a `diffdelver:raise` event; one stop for Tab in a file, the arrow keys moving among them by `gutter-lines.ts`, Shift or a drag taking a run of lines on one side, a plain click on a line's code or row putting the keyboard on its number, without scrolling, and the number the keyboard is on marked however it got there, and one set of listeners on the table for all of them; a plain click elsewhere in a file's part, on none of its controls, makes it the part the keys act on, in `Part.svelte`), with what is under a line looked up as it is drawn (`core/review/comment-places.ts`), coloured by language once their colours come (asked for after its lines, a few parts at a time and only while no part's lines are being fetched, and marked `aria-busy` until then), a long hunk drawn a chunk at a time as it comes near the screen (`core/viewer/chunks.ts`), `draw-line.ts` a line drawn as text with `line-pieces.ts`, its coloured text in classes the page's styles colour, `FileList.svelte` the by-file view, made when first shown and drawn a batch a frame, `SearchBar.svelte` the search box, `search.svelte.ts` searching the diff (the daemon counts each part's matches across the whole diff; the page finds where they are in a part's lines, with `search-places.ts`, when it has them, and moving to one opens and draws what it needs and puts it back when the search closes; `search.test.ts` tests it against a real daemon; a match moved to is kept in the middle until the reader moves by their own input, which `reader-input.ts` tells from the page's own scrolling; every move the page makes on its own, to a part, a summary, a match, a bookmark, a comment, Finish, the next section's heading or the notice that everything is reviewed, eases into place through one `PageMover` (`page-mover.ts`), as does showing the overview in the rail, which scrolls the rail (`reveal`), worked out again each frame so it follows a page that grows, stopped by the reader's input, jumping with reduced motion, and settled at once before a tick, a regroup or a change of setting measures where the reader is, while keeping the reader's place stays a jump; `tests/support/page-easing.spec.ts` checks it without reduced motion; it also says which click only says where the reader is, `isPlainClick`, one plain click with no text selected when pressed or let go, so a drag or double click selecting text is left to the browser, with `textSelected` and `ownControlAt`, the control, comment or note a click was on, which answers for itself), `comments.svelte.ts` the reviewer's comments and flags as the page holds them (a flag saved at once with `flag`, never a second on the same lines), the saved draft and what is being written, the overall review among them, and `kept-comments.ts` each Delve's, kept by the tab in memory and by nothing else, not by a viewer or a page, so nothing typed is lost to an update, a regroup, a file put away, or leaving the Delve by one of diff delver's own links and coming back (the list of Delves says which has a comment or an overall review not saved yet); `CommentBox.svelte` the box a comment is written in, under its lines while they are on the page and in `CommentList.svelte` when they are not, where a new comment whose lines are in a version no longer shown waits until the reviewer chooses lines of the version shown; `SavedComment.svelte` a saved comment or flag (a flag in the colours for attention, with Add words or Edit words, and Clear, which does not ask), under the last of its lines and in the list of all of them, its words drawn by `CommentWords.svelte` as text with what cannot be seen written out (`core/review/comment-words.ts`), with Edit, which opens the same box in its place with its words (one box, where Edit was pressed, when the comment is drawn in both places), and Delete, which asks first, from where the Delve's page goes to its lines (`goToComment`: the part that owns them opened and drawn, and a window opened around a line that is folded away, as when a bookmark is returned to), as it does to a box being written among the lines; unchanged lines still folded away say when a comment is on them; `OverallReview.svelte` the overall review's bar, pinned to the foot of a Delve's page (`position: sticky`, above the bookmarks a narrow window keeps there, with the page's `scroll-padding-bottom` set to its height so what takes the keyboard is scrolled clear of it): put away, the first words of what is saved, or that nothing is, and whether something typed is not saved; open, the box it is written in, saved as a comment's words are; either way the draft's comments counted and, while the Delve is open, a button that takes the keyboard to Finish and copy; on a closed Delve, the saved words as text, and what was typed before it was closed, with why neither can be saved or finished until it is reopened; whether it is open is the person's setting, and `v` opens it and takes the keyboard to its box; `FinishReview.svelte` finishing the draft as the Delve's next review with one press of "Finish and copy", which copies it, with what it will hand over shown first and the finished reviews to copy again or read; on a pull request's Delve, "Finish and post to GitHub" posts it as one review too, as Comment (chosen to start with), Approve or Request changes, or, with "Post as a draft on GitHub" ticked, as a draft, the kind then set aside and said so, beside "Finish and copy only", with how many comments go in the review's text said before it is posted and "Show what will be posted" showing the review's text as GitHub will have it, without its mark, and which comments go on their lines and which in its text (from the `preview` route), the button pressed saying it is under way, after "Finish and copy only" was refused because an earlier post of the review that went unanswered could not be looked for on GitHub (the API's `EarlierPostUnchecked`), "Finish and copy anyway — review N may already be on GitHub", which forgets that post and never posts, and a finished review says where it was posted, with a plain link out to it on GitHub, for a draft one to submit it there (`rel="external"`, nothing loaded from GitHub); `SortWithAgent.svelte` how to have an agent sort this Delve, offered under "Not sorted yet" while anything is not sorted and the Delve is open: a button that opens three steps in place (connect the agent, start it in the Delve's repository, the sentence to paste), asked of the daemon when opened and again when the person comes back to the page, so it says when an agent has connected; whether it is open is the Delve's page's, which puts it away when an agent's first sections arrive and then says that an agent has started sorting; `ImageDiff.svelte` a changed image as pictures, each side it has with its size in pixels and bytes, read through the `image` route, compared side by side, with a slider (a range input, dragged or moved with the arrow keys), in onion skin, or by its pixels, worked out in the page on a canvas; the way is the page's, the same for every image and kept through updates, and `i` steps through them; `AgentNote.svelte` an agent note under the last of its lines (DESIGN 5), marked as the agent's and drawn quieter than the reviewer's own, its words through the sanitiser, with Promote to review and Dismiss while the Delve is open and the browser may write the draft, and `AgentNotes.svelte` the notes of the version shown counted above the diff, apart from the comments, with the toggle that hides them all (the person's setting, and `a`) and the way to bring dismissed ones back; the notes come with the frame of the version shown (`viewer.notes`), so an agent's arrive as its overview does, and are changed through the `notes` route; `AskBox.svelte` the one Ask box under lines (DESIGN 7.2), about the lines, their whole file or their section, chosen in it, with "Explain this" and "Show me related code", which ask at once, beside the reviewer's own words, and whether an agent is connected; `AgentRequest.svelte` a question for the agent, drawn under its lines, at the top of its file's first part, under its section's summary, or, asked on another version, in a list above the diff: its status, the agent's answers through the sanitiser with the excerpts the daemon read, "Copy as prompt" while it waits with no agent connected, Cancel question while unanswered and Promote to review once answered on lines; the questions and whether an agent is connected come with the frame (`viewer.requests`, `viewer.agentConnected`), so an answer arrives as the agent's other writing does, and are changed through the `requests` route; `TickRefused.svelte` why a tick did not happen, said where it was made, `Shortcuts.svelte` the list of keys, and `keys.ts` the keys themselves (`F`, the next flag, is the page's `nextFlag`, in reading order), which never fire while typing. |
| `src/**/*.test.ts` outside core, and `scripts/**/*.test.ts` | The `integration` Vitest project. `src/lib/scale.test.ts` measures the pure diff model and the carry-over at full size here, for the larger guidance, and `src/lib/work-growth.test.ts` counts its work at two sizes, so a quadratic slowdown in core's own code fails on any machine; work done inside a built-in such as `includes`, a spread or `sort` counts as one step, so it is not seen there. |
| `tests/journeys/` | One Playwright file per journey, `j<N>-<name>.journey.ts`, with the journey's name as its `describe` and one test, written with the journey helper's steps. They run in Chromium against one production build, each with a daemon of its own (`tests/support/journey-world.ts`). `playwright.config.ts` fixes what could vary: viewport, locale, timezone, colour scheme, motion, and the browser's text rendering and fonts. `screenshots/` holds every step's committed images, `<journey>.<step number>.<step name>.<light or dark>.png`; never edit them by hand. |
| `tests/speed/` | The viewer's speed on a large diff (2,000 files, 200,000 changed lines, the `large` repository of `journey-world.ts`) and on one change of 80,000 rows (`long-file`), in the journey browser: time to first readable content, to move to the next file, to tick one, to tick and untick the whole group (with the part requests that sends, bounded), to show every file, and to show and tick the very large change, timed in the page and recorded as Playwright annotations (`MEASURED_TIME_ANNOTATION`), which `pnpm verify` warns about when over their guidance, as it does the Vitest measurements. |
| `src/lib/server/mcp/` | MCP over streamable HTTP (DESIGN 7.1): `mcp-server.ts` answers each request to `/mcp` with a server of its own, stateless and in plain JSON, listing each tool's input schema from its Zod schema and calling it; `tools.ts` holds the tools, each a thin layer over the report service with one strict Zod schema that checks its input and is its published schema, a description written for an agent that has read nothing else, and answers from `#lib/core/agent/`; `input-problems.ts` turns Zod's issues into sentences about the call; `agent-errors.ts` says the service's errors in terms of the call. Writes take the `version` the agent read and are refused, saying what to do, when the diff has moved on. `wait_for_requests` long-polls the report service for at most `MAX_WAIT_SECONDS` (45, below the usual clients' tool time limits; a test passes `timeout`: 1), and `answer_request` reads each of its `references` from the report's snapshot as an excerpt before the service stores it, so an agent never sends code. `mcp-server.ts` also tells the daemon's memory of agents (`AgentActivity`) that a message came, with the folder its shim was started in, and which report a tool call named. `agent-surface.ts` is what an agent sees of it, committed as `fixtures/agent-surface.json` (`pnpm mcp:surface`); never edit that by hand. |
| `src/lib/core/agent/` | The tools' answers, pure: each starts with the report and its version and is never longer than `MAX_ANSWER_LENGTH` (`answer.ts`, with `boundedAnswer` as the guarantee, and lists that stop by length as well as by count, with a long path shortened by `listedPath`, so what follows a list is never cut); the manifest, a summary (with a pull request's title and description, quoted as untrusted text and cut short) then a line per file, and the labelled diff, each in pages of about `PAGE_LENGTH` with a cursor that names the version, the place and the filters (`page-cursor.tiny.ts`); what is left to sort and the warnings, cut and counted (`coverage-answer.ts`); what each `assign` item took or why not (`assign-answer.ts`); what an `add_notes` call did to the version's notes (`notes-answer.ts`); a section's reading order, as `set_reading_order` answers it and the manifest lists it (`reading-order-answer.ts`); lines of a file for context (`file-answer.ts`); a review the person finished, as the text they copied between markers, in parts of about `PAGE_LENGTH` (`review-answer.ts`); and the person's requests handed over by `wait_for_requests`, at most `MAX_REQUESTS_PER_WAIT`, each quoted with what it is about in get_diff's labels, with an update, a finished review or a close since the last wait, and what `answer_request` did (`requests-answer.ts`). |
| `src/lib/core/diff/` | The diff model (DESIGN 4): reading git's diff output, change units, assignment, coverage, slices and the agent-facing diff text. `file-unit.ts` says when a file has a file-level unit (no lines, or a change to its name, mode or kind beside them) and gives the plain words for it and for how a file changed. Import it from `#lib/core/diff/index.ts`, its one entry point. `fixtures/` holds git output recorded by `pnpm fixtures:capture`; never edit it by hand. |
| `src/lib/core/range-set.ts`, `range-map.ts` | Sets of whole numbers and maps from them, stored as intervals. Line assignments are stored in them, and reviewed marks should be too. A set of change units, such as the reviewed marks or the units new since the previous version, is a `UnitSet` (`src/lib/core/diff/unit-set.ts`). |
| `src/lib/core/path-bytes.ts` | Paths that are not valid UTF-8: decoded losslessly from git's bytes (odd bytes become U+DC80 to U+DCFF), the exact bytes back for reading a tree, and the escaped form people and agents see and `assign` accepts: odd bytes as `\xHH` and, in any path with a backslash or an odd byte, backslashes doubled, so no two paths look alike. The decoding itself is in `path-codec.ts` and the escaped form in `escaped-path.tiny.ts`.  How a path is shown to a person, on the page, in what is read out and in every message, is `shown-path.tiny.ts`: the escaped form with each character that cannot be seen, or turns text round, written as an escape, by the same rule as code's (`hidden-characters.ts`); `PathText.svelte` draws it with those escapes marked. |
| `src/lib/core/clock.ts`, `ids.ts` | Where time and ids come from: a `Clock` and an `IdSource` (report, revision and snapshot ids, and the secret of each GitHub review's mark) are passed in, never read or made in place, so journeys can fix them. `settableClock` and `sequentialIds` are for tests and journeys; the real clock and random ids are in `src/lib/server/system.ts`. |
| `src/lib/core/reports/` | Reports and revisions as stored (`report.ts`), what makes two sources the same source (`report-identity.ts`, DESIGN 6.1), the agent's section requests, with each section's cross-references to lines in other sections and the removal of empty sections (`section-requests.ts`), a section's reading order (`reading-order.ts`, DESIGN 4.3.1: its steps, each narrowed to the section's units no earlier step took, a step that takes none refused, the steps as a version reads them after an `assign` or an update, `effectiveOrders`, where a unit is read, `StepLookup`, and the steps as unit sets for the carry-over), reports in plain words (`describe-report.ts`: a report's title is its source in words, and a run of commits is titled by its commits, kept with the report), a diff's size and its words (`diff-size.ts`: files and lines, with the lines that are tests, of role `test` or `snapshot`, counted apart so the rest and the tests add up to the whole, by the roles stored or, with no Delve yet, by the path rule a first version uses; and its binary files, added, removed and changed, with their sizes in bytes), what a report's page says when its source has nothing left to review, with the source to offer instead (`nothing-left.ts`), and moving between Delves (`switch-delves.ts`: the repositories the Delves listed are of, each once and marked when two share a folder name, the folder to show beside a Delve when its repository's name alone does not say which it is, when a list of Delves gets a box to find one by name, and finding by the words typed, in a Delve's title, its repository or the folder where that is shown). |
| `src/lib/core/update/` | Bringing a diff up to date (DESIGN 6.2): `line-map.ts` says where each line of a later tree was in an earlier one, from git's diff between the two (renames followed; copies, new files and binary files followed by nothing); `carry-over.ts` gives the new version's assignment state, reviewed marks (and, with `carryUnitSets`, any other set of units, such as cross-references), the units new since the previous version and those whose mark it took off (`unmarked`, which the page explains), with the matching rule and the rule for keeping a mark (nothing new or removed within `MARK_DISTANCE` shown lines) at its top, and `near-changes.ts` measures that distance; `update-summary.ts` is what an update did, in counts and in plain words. `carry-over.invariants.test.ts` holds the invariants over random histories (with renames, copies and changes of mode and kind), and `carry-over.distance.test.ts` the examples of the distance rule. |
| `src/lib/core/viewer/` | What the diff's page shows, pure, so the page and the routes count the same things: each file's parts (one per group it has changes in, and in a section with a reading order one per step it has lines in, the steps first and the rest in path order) with their tallies of changes, reviewed, new and unmarked, and the page's frame, the groups in reading order and every file once (`parts.ts`); one part's lines when open, its hunks, hunks of other groups as one block that says where, and the unchanged lines between them to open, numbered on both sides (`part-lines.ts`); the next part that waits, the next and previous part shown, from wherever the reader is, even a part the filter has just hidden, and what "only what I have not reviewed" shows (`reading-order.ts`); the next unread place with the agent's overview and each section's summary among the parts, a summary waiting while unread and while its section has a part that waits, and what is left to read in words (`reading-places.ts`); a line in pieces, with tabs, trailing white space, a carriage return and characters that cannot be seen made visible, and its text split where its colours change (`line-pieces.ts`); runs of line numbers and their form in an address, `1-20,40-60` (`line-spans.ts`); a part's lines paired side by side, as GitHub pairs them (`side-by-side.ts`); which changes only change white space, by the rule at its top, drawn as unchanged lines when the person hides them (`white-space.ts`); counts and sizes in words (`words.ts`); a group written in an address (`group-text.ts`); which unchanged lines a step opens, twenty at a time from either end or all of them (`expansion.ts`). |
| `src/lib/core/search/` | Searching, pure: the text a person searches for (`search-text.tiny.ts`), finding it in a line as plain text with only A to Z folded when case does not matter, as git's own search does in the store (`find-text.ts`), what a search of the diff reads of each part and how its matches are counted, the same in the daemon and on the page (`diff-search.ts`, with `DiffSearchIndex` for the daemon), and marking matches on drawn pieces of a line or a path (`marks.ts`). |
| `src/lib/core/github/` | GitHub pull requests as a source (DESIGN 3.1, 6.1), pure: the tiny types of a host, an owner (a repository's, never one of GitHub's `[bot]` accounts), an author (a pull request's, which may be one), a repository's name, a branch, a number, a title, a description and a token (`*.tiny.ts`; a token's parse error never holds it); a repository on GitHub and which of a local repository's remotes are on it, from their addresses in any of git's forms, github.com only so far, and the one whose pull requests it offers, `upstream` first, as a clone of a fork names the repository it was forked from, then `origin` (`github-repository.ts`); a pull request read from its address, written back in one form, its identity (host, owner and repository in lowercase, number), its title in words (`Pull request #12: “…”`) and what a Delve of it says when it was merged or closed or has nothing left, and when commits were pushed to it or only its base changed (`pull-request.ts`); and an open pull request as the choose page lists it, with the words of its row and of the list (`listed-pull-request.ts`). `src/lib/core/sources/source-spec.ts` is every source a Delve follows, a git source or a pull request: text written as a web address is read only as a pull request's.; and a finished review as one pull request review (`github-review.ts`): which comments GitHub can place on their lines (every line in one hunk of the version reviewed, on its side, a run with its first line; a comment on an earlier version, outside every hunk, on a file GitHub shows no lines of, on a copy's old side or on a path that is not UTF-8 goes in the review's text with its file, lines and code, never dropped), the text (the overall review, with any code fence or HTML block it leaves open ended after it, `open-blocks.ts`, which follows HTML blocks that end at a blank line too, since a fence inside one is not a fence, so nothing after it is swallowed or hidden, those comments, the flags under their own heading, never on lines, and a mark GitHub does not show that names the Delve and the review, with a secret made for each post, `review-mark.tiny.ts`, so nobody can plant one before it is posted), the kinds it is posted as (Comment, Approve, Request changes, or a draft on GitHub) and their words, the most characters GitHub takes in a review's text and in each comment (`GITHUB_TEXT_LIMIT`, checked before anything is sent), and the review's id and its address on GitHub, made from the pull request and the id, never taken from GitHub's answer (`github-review-id.tiny.ts`, `github-review-address.tiny.ts`). |
| `src/lib/server/sources/github/` | GitHub pull requests as sources, imported from `index.ts`. `github-access.ts`: how GitHub is reached (`GitHubAccess`: the API's address, the address git fetches a repository from, made from its name and never taken from GitHub's answers, and the person's token, from `gh auth token`, else `GITHUB_TOKEN`, asked each time and kept nowhere, and the time limits, `GITHUB_SECONDS` for a request and the much longer `GITHUB_FETCH_SECONDS` for downloading a pull request's commits), which the daemon and the report service take as an option so tests give the stand-in's. `github-api.ts`: the REST calls, one pull request (asked with its last answer's `ETag`, `github-etag.tiny.ts`) and a repository's open ones, each with a time limit and its answer read with Zod, how long a refusal for too many requests asks to wait, and every refusal a typed error (`github-error.ts`, each with its message: sign in with `gh auth login`, the token was refused, no access, too many requests, not found, unreachable). `github-remote.ts`: a local repository's remotes on GitHub, from its config, offline, a partial clone's too. `snapshot-pull-request.ts`: a pull request's snapshot, its branch (`refs/pull/<n>/head`) and base fetched into the store with the clone borrowed read-only as alternates, unless it is partial or shallow, when GitHub would leave out what the clone never downloaded, written into a folder of its own with the store and the clone as alternates and kept as a pack so nothing in the clone is touched, under refs of its own (`FETCHING_REFS`) deleted once its trees are found, before it lets the store go, the token only in git's environment as a header for GitHub's address, never in its arguments (`fetchEnvironment`, `fetchArguments`, tested by `snapshot-pull-request.test.ts`); base is the merge base; and its fingerprint (head commit, base branch and the commit GitHub last saw it at). `kept-fetches.ts`: each download kept in the store as the pack GitHub sent, with a `.keep` file naming the pull request (by a hash of its identity) and the commits it fetched, which the next fetch, of any pull request of the store, points refs of its own at while it runs, so git tells GitHub it has them and an update downloads only what is new, from a clone not fetched again and from a partial or shallow one alike; never refs in between, since their history may be in the borrowed clone and the store's collection walks every ref, while a kept pack it never touches. When a fetch that offered them fails, as it does when that clone is gone, it is made again without them, and only if that works are they forgotten: every one kept before the first try, and what that try kept, since which could not be used is not known without walking each one's history, and a failure of both says nothing against them; forgetting removes only the `.keep` file, and the next collection frees what no snapshot uses. A move into the store stopped midway, which leaves our `.keep` beside a pack with no index, is removed with its parts by tidying once it is older than the grace period (`removeHalfKeptFetches`). `pull-request-downloads.test.ts` in the report service counts what each download brings. `review-post.ts`: posting a review (`postReview`, a POST that is never redirected, its token only in the header, GitHub's 422 read, from GitHub's own words, as a draft review already there, which keeps GitHub from taking any other, one's own pull request, a text too long, a commit no longer in the pull request, as after a force-push, or, only when they name a line, a path, a position or the diff, lines it cannot place) and finding one posted before by its mark, only among the reviews of the account signed in (`GET /user`), so one planted by anyone else is never taken for it (`findReview`), and why a review was not posted (`ReviewNotPosted`, each reason with its message, which says nothing was finished and the draft is as it was). |
| `src/lib/core/history/` | The choose page's rules and words, pure: a branch's full name (`branch-ref.tiny.ts`) and where it is kept, in this copy or as its record of a remote's branch, so that two branches whose names read the same are told apart by a tag and a local branch named like a remote's, or `HEAD`, is never called by its short name alone (`branch-place.ts`), a commit's author and subject as a list shows them, a remote's name and a count of commits; the rule that keeps the commits chosen one unbroken run of a branch's first-parent list, whatever is ticked, the source it opens (the commit alone, or the range from the parent of its oldest commit, or from git's empty tree when that is the first commit) and the words for it (`commit-selection.ts`, with its invariant held by a property test); what is kept of a run of commits, how many it is and the subjects of its oldest and newest, each cut to `RUN_SUBJECT_LENGTH` characters (`run-subject.tiny.ts`), and the title made of them, such as `3 commits: “Add a discount rate” to “Say which code was used”` (`commit-run.ts`); when something happened and how far a branch has gone from the main branch, and when the repository last fetched, in words (`history-words.ts`); and what a remote has that this copy has not fetched, from `git ls-remote`'s answer, with why a remote could not be asked, read from what git and ssh say (`remote-check.ts`). |
| `src/lib/core/image/` | Images as pictures (DESIGN 8.4), pure: which files are images the page shows, PNG, JPEG, GIF, WebP and SVG, known by name and then by the start of their bytes (`bytesToKnowFormat`), the content type each is served with, and the largest shown, `MAX_IMAGE_SIZE` (`image-format.ts`); how much larger a small image is drawn, the same for both sides so they line up, and an image's size in words (`image-words.ts`); the ways a changed image is compared, in the order the `i` key steps through them (`compare-modes.ts`); and which pixels changed, over the RGBA bytes a canvas gives, lined up at the top left, with the picture that marks them in magenta over a copy of the image after faded toward white, drawn on a light ground in both themes, and the most pixels compared (`pixel-difference.ts`). |
| `src/lib/core/highlight/` | Colouring code by language (DESIGN 8.3), pure: the kinds of code the page colours and a run of colour on a line (`colour-run.ts`), which language a file is in, from its name or a `#!` line, and how one is added (`language.ts`), and when a file is too large or looks minified to colour, and how long a line of each language may be and still be coloured (`limits.ts`). |
| `src/lib/server/highlight/` | Colouring in the daemon with Shiki, its grammars bundled and run by its JavaScript engine (`highlighter.ts`): a whole side of a file at a time, a short slice of lines per turn (a line's worth of characters at most) with the grammar's state carried over, every grammar registered when it is made and compiled when first used, and nothing in the colours depending on how long they took; and the colours of whole files kept by blob and language, packed in typed arrays, the oldest let go past `MOST_BYTES_KEPT` (64 MiB) (`file-colours.ts`). `ReportService.readColours` gives the lines a page asks for. |
| `src/lib/core/settings.ts` | How the person likes diffs shown (code coloured, one column or side by side, white-space changes hidden, the overall review's bar open or put away, the agent's notes shown or hidden) and searched (match case, changed lines only, skip closed files), with its defaults. Kept in the database's `settings` table (one row per setting changed), so it lasts across diffs and restarts of the daemon, and each journey, with its own data folder, starts from the defaults. |
| `src/lib/core/review/` | The reviewer's own state (DESIGN 5): reviewed marks per change unit, as line ranges per file and side (`reviewed-marks.ts`); marking a slice, a file or a group (`mark-reviewed.ts`); progress in units and slices per group, per file and overall, with Ignored beside the total (`progress.ts`); a draft comment or flag (`ThreadKind`: a flag is a draft comment of kind `flag`, in the same tables and routes, whose words may be none), what its words may be and its lines in words (`draft-comment.ts`); the draft's overall review, what its words may be, the teaser a bar shows of it and the draft's comments counted in words (`overall-review.ts`); where comments are drawn among a file's lines, a run of lines taken on one side, and what a comment says when its lines are in another version than the one shown (`comment-places.ts`); a comment's words as drawn, line by line (`comment-words.ts`); the agent's notes (`agent-note.ts`, DESIGN 5: a label, `possible bug`, `risk`, `question` or `info`, on one range of change lines on one side, checked against the diff and narrowed to the change lines in it, with the bounds on how many and how long, and the words of a note promoted into the draft, which quote the agent and say so; a note is never the reviewer's and never in a finished review unless promoted); the reviewer's requests to the agent (`agent-request.ts`, DESIGN 7.2: about lines on one side of a file by the diff's path, a whole file, or a section; waiting, delivered, answered or cancelled; the agent's answers with the excerpts of code they point at; the bounds; the two ready-made questions; the prompt "Copy as prompt" gives; and the words of a promoted request, which quote the question and the agent); and a finished review as text written for a language model, the same text the clipboard and `get_review` give, with the code each comment is on, the flags under "Flagged for another look" and what was not reviewed (`review-export.ts`, DESIGN 8.6). A review's number is `review-number.tiny.ts`. |
| `src/lib/core/storage/` | The pure half of storing the assignment state and the reviewed marks: turning them into rows of unit runs and back, checked against the diff, so a damaged table is an error and not a wrong review, and finding the file-level units that rows written before files with lines had them lack (`pathsMissingFileUnit`). |
| `src/lib/server/db/` | The database (DESIGN 9): one SQLite file, `diff-delver.sqlite`, in the data directory, opened with `node:sqlite` (`Database.open`, from `index.ts`). Numbered, forward-only migrations in `migrations.ts`, each in a transaction and recorded in `schema_migrations`; `Database.open` takes the list, the real one by default, so tests can add a migration (`Database.openToRead` opens it read-only and changes nothing, for `newestMigrationIn`), and one that rebuilds a table to change its constraints runs with foreign keys off and is checked before it is recorded; a database a newer diff delver changed, a file that is not ours and a damaged file are each a typed error. All SQL runs inside `read` or `write`, one transaction each, synchronous, and a `write` whose work fails changes nothing. `tables/` has one module per table, the only code that sees raw rows, which it parses into domain types with Zod (`columns.ts`); a row that does not parse is `StoredRowInvalid`, naming the table. `data-version.ts` reads SQLite's `data_version`, which changes when another connection writes, the one row read outside `tables/`. Paths are BLOBs of git's exact bytes, because a TEXT column would merge paths that are not UTF-8. |
| `src/lib/server/reports/` | The report service, imported from `index.ts`: the one entry point the daemon's routes and the MCP tools call. `ReportService.open` takes the data directory, a `Clock` and an `IdSource`; its methods open a source as a report or resume it (`start` for the no-argument start, `open` for one source; a run of commits is read once, then, for its title, and kept in `commit_runs`), load a report for display from the database and the store alone, at its current version or one a page still shows, read one part's lines with only its file's rows (`readPart`, with each side of an image the page shows as a picture) and one side of an image as it is (`readImage`, refused past `MAX_IMAGE_SIZE` from its size alone) and lines of a file from the snapshot (`readLines`), list reports (one whose rows cannot be read is listed as damaged beside the others, and can be deleted) or give one as the list does (`summary`), apply the agent's sections (with their cross-references, kept as the changed units they name), its overview (`setOverview`), a section's reading order (`setReadingOrder`, all or nothing, kept in `reading_steps` as the version reads it: `assign` takes out of a step what it moves out of the section, and an update carries the steps with the lines they name, as cross-references), `assign` and its notes (`addNotes`: all or nothing, on the version the agent read, a note the version holds already passed over, and with `replace` the agent's notes the reviewer has not acted on removed first; kept in `agent_notes`, apart from the draft, each on the revision it was written on and loaded with it; the reviewer dismisses one or brings dismissed ones back, `setNoteState` and `restoreNotes`, or promotes one, `promoteNote`, which writes a comment of the draft that quotes it in the same transaction), take the reviewer's requests to the agent (DESIGN 7.2: `askAgent` about lines, a file or a section of the version shown, `cancelRequest`, and `promoteRequest`, which writes a comment of the draft on its lines that quotes the question and the answers; kept in `agent_requests`, apart from the draft, each on the revision it was asked on, its answers in `request_answers` with the code they point at in `request_answer_excerpts`, and loaded with the frame on every version) and the agent's side of them (`waitForRequests`, which hands the requests waiting over as delivered at once, or waits for one, woken when one is asked and looking again every `WAIT_CHECK_EVERY_MS` for an update, a finished review or a close, which it says against what the Delve's last wait saw, in memory; while it is open, and for a while after, the frame says an agent is connected and its stamp changes with that; and `answerRequest`, an answer the same as the last passed over), search a version's diff part by part (`searchDiff`, with each revision's index kept while its sorting stays the same: every write of the sorting goes through `sorting-writes.ts`, which counts it, and lint keeps the tables' own writes from any other module), save the draft's overall review (`saveOverallReview`, on any version while the Delve is open, only on the words the page read, by their count of changes, which is never reset), finish the draft as the report's next review (`finishReview`, only when the draft holds the comments and the overall review the page showed, and, after a post to GitHub whose answer never came, only once GitHub says that review is not there, else recording the one found as posted, and refused while GitHub cannot be asked, recording the text handed over, the overall review, the comments with the code they are on and a copy of the reviewed marks, and emptying the draft, its overall review too), post it to its pull request as one GitHub review and finish it (`postReview`: one post or finish of a Delve at a time, either press, the other refused; the draft checked as the page showed it and the pull request asked whether it is still open, the draft, the version and the review's number checked again in the transaction that notes it, exactly what is sent noted as being posted in `github_review_posts` (its number, text, comments with their counts of changes, marks, kind and whether every comment went in its text), then sent, posted again with every comment in its text when GitHub refuses their lines, and only once GitHub made it recorded from the note, as GitHub says it was posted, with where, `review_deliveries`, in the transaction that takes what was sent out of the draft, even when the Delve was updated or closed while it was being posted; a failure finishes nothing, and a note left by a post GitHub may have taken unanswered, or by a daemon stopped midway, makes the next post look on GitHub for the review's mark first, so it is never posted twice, and posts it again only with the same mark and once twice a request's time limit has passed since it was sent, by the service's clock, since GitHub may still be making it (until then both buttons say to wait a minute), and records what that post sent, leaving in the draft what was added or changed since, a changed comment under a new id; when GitHub cannot be asked, finishing and copying only is refused unless the reviewer chooses `forgetEarlierPost`, which forgets the note and finishes it as copied only), give what finishing would hand over (`previewReview`) and the finished reviews (`reviews`, `review`, which never gives a draft), record that the reviewer read the agent's overview or a section's summary (`markSummaryRead`, kept in `summaries_read` per Delve by a hash of the text, so the same text is read in every version and a rewritten one is unread again; never the agent's to write), mark slices, files and groups reviewed (each on the version the caller saw: when the report was updated since, nothing changes and the answer is `VersionOutOfDate`, or `VersionNotFound` for a version it never had), close, reopen and delete reports, check whether a source can be opened at all and has anything to review (`checkSource`, cheap and writing nothing: git's changed paths without their contents, and whether its store could be made, for the page that says why it could not be opened), whether it changed or has nothing left to review (`checkForChanges`, which never closes the report, shares one check under way between callers, and says where its changes most likely went, from `core/reports/nothing-left.ts`; opening the source again then closes it; given the version a page shows, it says first when a newer one exists), open and follow a GitHub pull request from any clone with a remote on its repository (`open` with a pull request's spec: its identity is the pull request's, so it resumes from any clone, updated through the clone it was first opened in while that is still one, or else the clone it was opened from, which it moves to, every version's snapshot in the Delve's own store so the sorting and the ticks carry over; a merged or closed one has nothing left to review; a page's check asks GitHub at most every `PULL_REQUEST_CHECK_EVERY_MS` by the service's clock, or `PULL_REQUEST_CHECK_SIGNED_OUT_EVERY_MS` signed out, with the tag of GitHub's last answer so an unchanged one costs a signed-in person nothing; opening and `update` always ask; a refusal is kept, one for too many requests until GitHub said to try again, for every pull request of its host and the list of them, while the person is signed in or out as they were when it was refused, any other for a minute, for that pull request's checks), list a repository's open pull requests (`pullRequests`), bring a report up to date (`update`, and opening its source again: the next revision with the sections, sorting and marks carried over by `core/update/`, in one transaction, reusing the snapshot the last check took when it is still the one needed; earlier revisions and their snapshots stay), remove snapshots a crash left behind (never one it holds for a check or an update), bring revisions an earlier diff delver saved up to date (those from before files with lines had a file-level unit when it opens, before the daemon serves, and again when one is read: each such unit without a row gets what a first version would give it and the revision's stored progress and test lines are computed again; `revisions_to_check` lists those left), count the binary files of revisions saved without them (`countBinaryFiles`, which the daemon starts once it is serving, one revision at a time, each Delve's current one first, stopped when the daemon stops; a revision read before its turn is counted then, and until then the list and the page say nothing of its binary files), so the list, the page and the command agree, and tidy the stores now and then (`tidyStores`: that, forgetting the downloads kept for a pull request with no Delve in that store once they are older than the grace period, and collecting the stores it discarded snapshots or downloads from). Deleting a pull request's Delve forgets its own downloads, and no other's, before its store is collected. Details only a bug report needs, such as which table of a damaged entry could not be read, go to its `log` (the daemon's), once. Every change is one transaction; every error has a message (`describeReportError`). `scale.test.ts` measures it at 2,000 files and 200,000 changed lines, `update.test.ts` updates through real repositories (renames, a rebase, calls at the same time, a failure midway), `github-reviews.test.ts` posts reviews to the stand-in GitHub, `pull-requests.test.ts` follows pull requests on the stand-in GitHub (open, resume, a push, a force-push, merged and closed, sign-in refused, not a clone), `service-model.test.ts` checks what it stores after random sequences of calls, updates among them, against what core computes, and that the list's progress and size, with its test lines, are the page's after every call, and `before-file-units.test.ts` opens `fixtures/before-file-units/`, a data folder written by the diff delver from before files with lines had a file-level unit, made by `pnpm fixtures:old-database`; never edit it by hand. |
| `src/lib/server/git/` | Running git. `run-git.ts` runs one command, isolated from the machine's git config, and returns typed errors (with `stopWhen`, in a session of its own, stopped with all it started when the signal fires; with `readUpTo`, stopped once that much of its output has come); everything that calls git goes through it, and its first run checks that git is new enough. `alternates.ts` lets one command read another repository's objects read-only, as git's alternates, quoted so any path survives. `read-diff.ts` reads the diff between two trees with the one fixed diff command, run in an empty repository that borrows the reviewed one's objects, so none of its config or attributes apply; for a partial clone it carries over only the promisor remote's settings, so missing blobs are fetched on demand. |
| `src/lib/server/store/` | The snapshot store (DESIGN 3.2), imported from `#lib/server/store/index.ts`: one bare git repository per reviewed repository at `<data directory>/stores/<store id>.git`, made atomically on first use (`ensureStore`); the data directory is a parameter everywhere, and `machineDataDirectory` gives this machine's default from the pure rule in `src/lib/core/data-directory.ts`. A snapshot is a base and a head tree pinned by one ref, `refs/diff-delver/snapshots/<id>`, pointing at a tree that holds both. `takeSnapshot` takes the new snapshot's id from the caller's `IdSource`, lets a source write its trees into the store, copies in the objects it still lacks from the source's object directory (borrowed read-only, never visible while git writes, because git touches an existing object it is asked to write) and pins them. Reading the diff, files, the start of a file without the rest (`readSnapshotFileStart`), the sizes of blobs in one call (`readBlobSizes`, for a diff's binary files), lines, a tree's paths, the diff between any two trees of the store (`readTreeDiff`, which an update reads between two versions' heads and bases) and the `linguist-generated` marks needs only the store. Every use holds the store shared and `collectGarbage` holds it exclusively (`store-lock.ts`), a lock within one process; `collectGarbage` first deletes every ref under `FETCHING_REFS`, which only a fetch stopped midway can have left, since one may point at a commit whose history was only borrowed and git could not walk it, and keeps unreferenced objects for an hour (`GRACE_PERIOD`), so a snapshot another process is taking keeps its objects, and git's atomic writes cover the rest. Folders a crash leaves behind (a store being made, a private index copy, a pull request's download under way, which tidying also sweeps) are removed after the same hour (`stale-folders.ts`). |
| `src/lib/server/sources/git/` | Local git sources (DESIGN 3.1), imported from `#lib/server/sources/git/index.ts`. `locateRepository` finds the repository a directory is in; its store is named by its common git directory with links resolved, and its object format, so subdirectories, symbolic links and linked worktrees share one store. `snapshotGitSource` turns a working tree, the index, a commit or a range into a snapshot without writing to the repository: commits are copied in read-only, and the working tree and index are written into the store with `git add --all` and `git write-tree` against a private copy of the index (`scratch-index.ts`), with the store as git's only object directory. `sourceIdentity` is the cheap check for change, `sourceHasChanges` the cheap check that a source can be read and has something to review, `commitsSince` tells which commits were made on top of the one uncommitted changes were made on, `readCommitRun` reads what a run of commits is made of for its title, or finds that two commit ids are not a run (`commit-run.ts`), and `suggestSource` decides what the no-argument start opens: uncommitted changes, else the branch compared with the main branch, else the start page's choice or the reason there is nothing, each candidate described in plain words with its size. Commands in the reviewed repository go through `gitIn`, which uses the reviewer's git config and never lets git fetch a missing object into a partial clone; tests pass their own config with `RepositoryOptions.gitEnv`. For the choose page, `history.ts` lists the branches (local ones, remote-tracking ones with no local branch of the same name, and the main branch itself, which alone is marked as the main branch, with how far each is from it, bounded to `BRANCHES_SHOWN` and found by name), a branch's first-parent commits a page of `COMMITS_PER_PAGE` at a time with each one's size from the same `git log`, the lines of files whose paths say they are tests counted apart and its binary files not counted, since that would read every blob (every commit git lists is a row, one whose date cannot be read too; a page says whether the next starts on the main branch, and one that does is listed without walking the main branch down to it), the remote-tracking branches alone, the size of a run, and when the repository last fetched (`FETCH_HEAD`'s time, or a fetch or clone in a remote branch's reflog); `check-remote.ts` asks a remote what its branches are at with `git ls-remote`, only when a person asks, never prompting (no terminal, an askpass that refuses, ssh in batch mode) and stopped after `REMOTE_CHECK_SECONDS`. `history-scale.test.ts` measures what the choose page asks of the report service on 100,000 commits and 3,000 branches: only the list of branches measures every branch, and a page of commits finds the main branch alone. The source spec and its plain-words descriptions are pure, in `src/lib/core/sources/`, as is reading why `git add` left a file out (`git-add-refusal.ts`). |
| `tests/support/` | Shared test helpers. `journey.ts` is the journey helper: a journey gets only its `Journey`, never a Playwright page or locator. `journey.step` waits until nothing on the page is `aria-busy`, then checks a screen (screenshots of the viewport in both themes compared exactly, bundled fonts only, no browser errors, and no refusal from the app's API but those the step declares, by route and status); a journey finds things by role, text or label, inside a region (`within`) or by place (`nth`), moves with `press`, `type`, `tabTo` and `activate` (which, like `open` and `step`, first wait for the page's `data-ready`, so no key reaches a page that is drawn but not yet working), checks with `expect…` methods that wait for the app (text, visibility, focus, a control's state), and uses `readClipboard`, `chooseFiles`, `editFile`, `commitAll`, `returnToPage` (the page's window gets the focus again) and `inAnotherTab` (a second tab, as running the command again opens, with a journey of its own whose screenshots are not kept) for what a person does outside the page; `repository` gives it a named fixture repository, `agentTrial` replays a recorded agent trial there against the journey's daemon, `agentCall` makes one call and gives its answer, as `get_review`'s, `agentCalls` makes an agent's calls one after another while holding what the page asks of the daemon, so the page's own refresh now and then, on a timer the journey cannot fix, never finds what lies between them, `agentLink` gives the address an agent is given for a repository's uncommitted changes, which lets a browser in to read and tick only, `pushToPullRequest` a commit someone pushes to a pull request on the journey's stand-in GitHub (the `on-github` repository's), `openedWindow` the address of the window the journey's daemon last asked the system to open (no browser is opened: the journey plays the window with `inAnotherTab`), and `command` runs `diff-delver` there as a person would, against the journey's own daemon, giving what it prints and the address it opens. Lint keeps journeys to it, and so to the keyboard (`scripts/eslint-journey-rules.ts`, tested by `scripts/journey-rules.test.ts`); the page itself is not watched, so the app may set its own fields and fire its own events. `journey.spec.ts` tests the helper itself, in the journey browser, on pages it plants. `journey-fonts.ts` and `fontconfig/` give the journey browser the bundled Inter as its only installed font. `journey-world.ts` holds the journeys' named repositories (built once per run, each copied into a folder named as its fixture, so the page names it the same on every machine) and starts each journey's daemon in its worker, on the production build, with its own data folder, the fixed `JOURNEY_TIME`, sequential ids and a stand-in GitHub of its own; the daemon is told that the journey's folder is the person's home folder and that its data folder is the machine's default, and the first repository of each folder name is at `~/src/<name>`, so a folder or a command the page shows is the same text on every machine. `daemons.ts` starts daemons for integration tests and makes raw HTTP requests with exactly the headers given; `build.ts` makes the production build for them when it is older than its sources. `git-repo.ts` builds real repositories with real git, with a fixed identity and dates (a minute apart by default, or as a fixture's `dates` set them, as the journeys' `history` repository sets them in the week before the journey's clock). `fixture-repos.ts` gives each integration test its own copy of a named fixture repository (`defineFixture`, `useFixture`), built once per run, a fresh empty one (`emptyRepo`), or a fresh empty directory (`tempDirectory`), such as a data directory. `report-rows.ts` makes reports and revisions with fixed ids and times for the table tests. `directory-listing.ts` lists a directory completely (kinds, modes, sizes, times in nanoseconds, inodes, content hashes), to prove an operation wrote nothing to it. `partial-clone.ts` makes blobless and treeless clones of a small server repository. `reviewer-git.ts` gives a test its own reviewer git setup (home folder and global config, never the machine's) and works out the tree real git would commit from a copy of a repository; `git-source-helpers.ts` takes a git source's snapshot while checking that the repository's listing did not change. `diff-fixtures.ts` defines the repositories with every awkward kind of change. `tree-diffs.ts` gives the diff between two modelled trees (a path to each file's lines, with the renames, copies and modes the test names), with Myers' algorithm, as the fixed diff command would, and `update-scale.ts` an update of 2,000 files for the carry-over's size tests; both are pure. `github-stand-in.ts` is the stand-in GitHub: real repositories that serve `refs/pull/<n>/head`, and a small HTTP server on a free port for the REST calls diff delver makes, which tags its answers for a pull request and answers 304 to the same tag, refuses on request with GitHub's rate-limit headers, and takes a pull request's reviews as GitHub does, checking its commit is in the pull request, its length, each comment against its own `-U3` diff of the pull request, no other review while the person has a draft one and no approving one's own, and lists them with their authors, answers `GET /user`, takes reviews planted by any account (`plantReview`), refuses the next ones on request, drops the answer to one it made, makes one only later (`makeLateReviews`), as after a time-out, or holds one until a test lets it go (`wait`), and records every request with its method, tag and status; `pull-request-fixture.ts` is acme/shop on it, with two open pull requests, and a clone of it whose origin is github.com's address. `mcp-client.ts` connects the MCP SDK's client through the real stdio shim (`mcpThroughShim`) or straight to a daemon's `/mcp` (`mcpOverHttp`), and reads a tool's answer as an agent does; `scripted-categorisation.ts` holds the shop repository (`buildShop`) and the calls that sort it from nothing to everything (`categoriseShop`, or `sortShop` for a report that exists already, given only its id), recorded call by call, for tests and as the agent trials' stand-in; `ledger.ts` is the agent trials' medium repository (`buildLedger`), 31 files and about a thousand change lines. `large-change.ts` is the repository of 2,000 files and 200,000 changed lines the size tests share. `png.ts` writes PNG files from pixels, and `image-fixtures.ts` is the repository of changed images (`buildImages`) that the image route's tests and J13 share. `synthetic-diff.ts` writes diff output for property and size tests, with arbitraries for `assign` calls and reviewed marks, and is pure, so core tests may use it. `stopwatch.ts` is the real clock, for the size tests that measure elapsed time, and `measured-time.ts` records what they measured against its guidance (`timed`, `recordTime`), for `pnpm verify` to warn about instead of the test failing. `work-count.ts` counts the blocks of core code a piece of work runs, with V8's precise coverage, for tests that hold work to a bound instead of a time. |
| `tests/agent-trials/` | The agent trials (see [Agent trials](#agent-trials)), with their results in its README. `run.ts` is `pnpm trials:run`: it builds the fixture outside this repository, starts a daemon in the harness's own process (`trial-world.ts`: the fixtures, the trials' fixed clock and sequential ids, and every report's final sorting written out), gives the agent a home folder of its own, and runs it with our MCP server behind `proxy.ts`, which logs every message both ways; `agent-cli.ts` is what each CLI is given (its arguments, settings and login) and how it is run and stopped, tested without a session by `agent-cli.test.ts`, and `run.test.ts` runs the harness with stand-ins for the CLI and its login. `recording.ts` is a recording's schema, how temporary folders, the port, entry codes, the home folder and the user name become placeholders, and what the skill forbids that a recording can show. `replay.ts` sends a recording's calls again; `replay.test.ts` replays every recording in `recordings/` through the real shim and scans them for personal data, and `skill.test.ts` checks the skill and the plugin. The agent's own transcripts go to the ignored `transcripts/`. |
| `plugins/claude-code/` | The Claude Code plugin, not installable yet (no marketplace, and no release for its server address to find): its manifest, an `.mcp.json` that runs `diff-delver mcp` from the newest release, and the skill, `skills/diff-delver/SKILL.md` (DESIGN 7.3), the one copy of it, which `skills/diff-delver` links to. |
| `scripts/verify.ts` | The `pnpm verify` runner. |
| `scripts/documents.test.ts` | Holds the documents to what they point at: every link from `README.md`, `docs/` and `tests/agent-trials/README.md` to a file or a heading finds one, and every picture in the README is a journey screenshot with both themes. |
| `scripts/release-package.ts`, `release-check.ts`, `release-preflight.ts` | Releasing (see [Releasing](#releasing)): `pnpm release:package` and `pnpm release:check`, and the release workflow's checks of what the person typed, run first and again just before the release, against the tags and releases `release-names.sh` lists. `release.test.ts` packs the build `pnpm verify` made and checks it, offline; `release-workflow.test.ts` holds the workflow to its rules and runs the checks. The release version (`src/lib/core/release-version.tiny.ts`) is three whole numbers with a `v` tag, and which of a running daemon and the command is newer, and what the command says when it replaced an older one or uses a newer one, with how to upgrade, is `src/lib/core/cli/replaced-daemon.ts`. |
| `scripts/test-time-limits.ts` | Each type of test's time guidance and its hang timeout, the only time limit that fails a test. The Vitest and Playwright configs and `pnpm verify` read it. |
| `scripts/journeys.ts` | `pnpm journeys:update`, `pnpm journeys:repeat`, and the check `pnpm verify` runs after the journeys for committed screenshots no step produces. `journey-screenshots.ts` names the images and finds stale ones; `png-pixels.ts` compares two images pixel for pixel; `woff-to-sfnt.ts` unpacks a WOFF font. |
| `scripts/test-timings.ts` | Reads the test reports and works out which tests went over their guidance, for `pnpm verify`; `test-notices.ts` reads the notices tests recorded. |
| `scripts/eslint-journey-rules.ts` | What lint forbids in journey files: Playwright's other fixtures, the methods that run code in the page or change it without input, direct input, and dynamic property access. |
| `scripts/eslint-core-purity.ts` | The lint rule `core/purity`, for what core may not touch that the built-in rules cannot see: `Date` other than `Date.UTC` and `new Date(value)`, `Temporal.Now`, `Intl`, `Reflect.construct`, `import.meta` and locale- or timezone-dependent methods. Tested by `scripts/core-purity-rule.test.ts`. |
| `scripts/capture-diff-fixtures.ts` | The `pnpm fixtures:capture` script. `capture-old-database.ts` is `pnpm fixtures:old-database`'s, and `mcp-surface.ts` `pnpm mcp:surface`'s. |
| `scripts/bd.ts` | The `pnpm bd` wrapper. `bd-push.ts` decides which commands are checked first, when a push is tried again and what a finding says; `private-data-scan.ts` finds personal and sensitive data in the issue data; `issue-tracker-identity.ts` holds the agent identity and the email allow-list. |
| `scripts/ci-commits.sh` | Lists the commits a push must verify, for CI, and splits them into jobs. Tested by `scripts/ci-commits.test.ts`, in the `integration` project. |
| `.github/workflows/verify.yml` | CI: `pnpm verify` on every commit of every push to `main`, including every rewritten commit of a force push. |
| `.github/workflows/release.yml` | The release, started only by hand: checks, `pnpm verify`, packing and trying the package, then the GitHub release. See [Releasing](#releasing). |
| `.beads/` | The beads issue tracker's settings. The issue database itself is not in git; it syncs through `pnpm bd push` and `pnpm bd dolt pull`. After cloning, `pnpm bd bootstrap` fetches it. `private-terms.txt`, if you make one, is ignored by git. |

**Tiny-type files.** A tiny type and its parse function live in their own file
named `<name>.tiny.ts` under `src/lib/core/`, for example `line-number.tiny.ts`.
Those are the only files where lint allows a type assertion (`as`) or a type
predicate (`v is T`, `asserts v is T`), since either can forge a tiny type. The
`Tiny` brand itself is in `src/lib/core/tiny.ts` and `Result` in
`src/lib/core/result.ts`.
Comments cannot switch lint rules off (`noInlineConfig`); fix the code instead.

Draft comments, and flags, which are draft comments of kind `flag` with words
that may be none, go through the viewer's `comments` HTTP routes and the report
service: the whole draft with the daemon's time, saving a comment, and, at
`comments/[comment]`, changing one's words or deleting it. Each row belongs to
the revision that supplied its snapshot, with the path bytes, side and line
range in that tree, when it was written and when its words last changed. Its
lines never change; its words can. A comment's id is never given to another
once it is deleted (the table's ids only count up), and each comment counts how
many times its words were changed. The service checks the current version
again in the transaction that saves the comment, and changes or deletes one
only from a page that shows the Delve's current version, whichever version the
comment's lines are in, and that sends the count it read, so a page that is
behind, or that another tab got ahead of, changes nothing, keeps what was
typed and says why. The draft's overall review is one row per Delve in
`draft_summaries`, its words exactly as typed (only white space is stored as
none), read with the comments and saved at `overall` on the count of changes
the page read; the count is never reset, so emptying it, as finishing does,
counts too. A finished review keeps the words it was finished with
(`reviews.summary`). Every comment route requires a review session cookie. The command's bearer token can issue
a review entry code. MCP uses a separate bearer token, and the addresses in its
answers carry entry codes that open the viewer with a separate cookie, which
cannot read or write drafts. A window the daemon opens itself carries a review
code of the daemon's own making (`openForReview` in `daemon.ts`): for an
agent's new report, where the tool names the page and is never given the
address, and when a page whose browser may only read asks for one
(`api/review-window`, `ReviewAccess.svelte`), which is told only whether a
browser could be asked. The page asks again whether its browser may write
whenever the person comes back to it (`app:review-access`, the layout's
load), so it turns comments on without a reload. The review cookie is named
by the data folder's id, not the port, and holds the data folder's token
(`browser-access.ts`), so it outlasts a daemon; the view cookie is one
daemon's. A cross-site link commits a local
page before opening the Delve, so the browser sends its Strict cookies on the
clean URL. The same review grant protects Delve deletion. The open Delve page
keeps unsaved comments across viewer replacement, and puts off a regroup
while the reviewer is taking lines or typing in a box among the lines, which
it would draw again under them. Gutter movement uses the logical rows of the
chosen layout and draws the destination chunk when needed. A comment's words
are kept exactly as typed and drawn as plain text with their line breaks and
tabs, never as markup, with each character that cannot be seen, or turns text
round, written as its escape, as in code and paths. The box sets no limit on
its field, which would cut a long paste short without a word: it says how far
over the words are, and will not save them. What is
typed and not saved stays in the tab's memory and is put in no storage. Only
loading the document again or closing the tab would lose it, and then the
browser asks first, on whichever of diff delver's pages the tab is.

## How we work

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
- **Speed is a feature of the suite, and coverage comes first.** Write tests so
  they run fast; never remove, shrink or skip a test that is needed in order to
  save time. The limits are under [Testing](#testing) and they are guidance.
- **Not published to npm.** The package is private and stays that way. Never run
  a publish command and never reserve the name on a registry.
- **Releases only by hand.** A release is made only by a person starting the
  release workflow; it runs every test before it packages. Nothing releases
  automatically, and nothing else makes a release, a release tag or an asset.
- **Work is tracked in beads.** See [Tracking work](#tracking-work).

The repository is used with both git and jj, and jj does not run git hooks, so the
check cannot rely on a pre-commit hook alone. `pnpm verify` and per-commit CI are
the mechanism.

## Releasing

A release is a tarball on GitHub, `diff-delver.tgz`, which the command under
[Use it](../README.md#use-it) fetches from the newest release. Only the release workflow makes one,
and only when a person starts it.

1. On GitHub, open **Actions**, choose **Release**, then **Run workflow**. Leave
   **Use workflow from** on `main`: any other branch is refused.
2. Type the **version**, three whole numbers with no `v`, after the newest release
   (`0.2.0`), and the **commit** you mean to release: at least the first 7
   characters of its id, from `main`'s history. If `main` has moved on since you
   looked, the release stops.
3. It checks what you typed and that no tag or release of that version exists; runs
   `pnpm verify` on the commit; builds it with the version written in, packs it and
   installs and runs the packed package (`pnpm release:package`, `pnpm
   release:check`); checks what you typed again, in case another release was made
   meanwhile; and only then makes the release `v<version>` on that commit, with the
   tarball, its checksum and notes that say how to run it. A refusal, or a failure
   before the step **Create the release**, says what is wrong, and nothing is
   released. It takes around ten minutes, most of it the tests; the run's page shows
   each job as it goes.
   If the last job fails once it has begun creating the release, the release or its
   tag may already exist, and the run says so: open the release's page, keep the
   release if it is whole (its notes and both files), and otherwise delete both the
   release and its tag on GitHub and start the workflow again.
4. Afterwards, open the release's page and check its notes and its two files; then, in
   a repository with changes, run the command under [Use it](../README.md#use-it) after deleting
   npx's copies (see [Upgrading](../README.md#upgrading)), and check `--version` shows the new
   version.

The scripts it runs can be run locally: `pnpm build`, `pnpm release:package`, `pnpm
release:check`. They never publish, tag or upload anything.

## Tracking work

Issues and tasks live in [beads](https://beads.gascity.com/) (`bd`), not in
documents, code comments or an agent's memory. If work is owed, found, blocked or
decided, it gets a bead.

Run beads through `pnpm bd`, which takes the same arguments as `bd` and passes
its output and exit status through unchanged.

| Command | What it does |
|---|---|
| `pnpm bd ready` | What can be worked on now: open, with nothing blocking it |
| `pnpm bd show <id>` | One issue, with its notes and dependencies |
| `pnpm bd create "Title" -t task -p 2 -d "…"` | A new issue. Types include `task`, `bug`, `epic` and `decision`; add `--parent <epic>` and `--deps <id>` |
| `pnpm bd update <id> --claim` | Take an issue and mark it in progress |
| `pnpm bd note <id> "…"` | Add what was learned or decided |
| `pnpm bd close <id> --reason "…"` | Finish it, naming the commits |
| `pnpm bd push` | Flag likely personal data, then publish the issue data (see the rules below) |

How we use it:

- One epic per build step in the design, plus one for process and tooling. Tasks
  hang off an epic and depend on what must come first, so `pnpm bd ready` is the queue.
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
  `user.name` into `created_by`). `pnpm bd` always runs it with the agent
  identity instead; plain `bd` does not, so do not use it to change issues.
- That rule is the control. `pnpm bd push` is a helper for honest mistakes: when
  the command `pnpm bd` runs is `push`, `sync` or `dolt push` (after any of bd's
  global flags, such as `-C <dir>`), it first exports the current issue data and
  flags any field that holds an email address not on the allow-list in
  `scripts/issue-tracker-identity.ts`, something that looks like a secret, a
  home-directory path, or a term from `.beads/private-terms.txt` (a file of your
  own, one term per line, matched as whole words in any case, never committed). It
  lists each finding with the issue and field, secrets masked, and stops; add
  `--anyway` to push regardless. It does not check history, tables the export
  leaves out, or anything pushed another way: plain `bd`, unusual spellings, or
  beads' own automatic push (`dolt.auto-push`, which stays off). If something
  personal has got in, do not push; tell the project owner, because removing it
  means rebuilding the database. A push that times out on the network is tried
  again a few times.

beads' usage metrics are switched off on the project's machines
(`bd config set metrics.disabled true`), and `pnpm bd` sets `DO_NOT_TRACK` as well.

## Tiny types

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
- `TextForAgent` and `ReviewerMessage` are labels, not checked values: any code
  may make one, and the type only records who the text is for. `GitStderr` is a
  label too, and lint lets only `run-git.ts` (and tests) make one.

Expected to exist from the start: ids for report, revision, snapshot, review,
section, thread, message and request; `TreeId`, `BlobId`, `CommitId`; `RepoPath`,
`Side`, `LineNumber`, `HunkId`; `Role`, `Bucket`; `ByteSize`, `Timestamp`;
`AgentMarkdown`, `HumanMarkdown`, `SafeHtml`; `DaemonToken`.

## Strong typing

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

## Testing

**Journeys.** The design lists the
[user journeys](DESIGN.md#10-user-journeys). Each one has one end-to-end test
with the same name. A feature is done when its journey passes. New behaviour starts
with a new or changed journey.

**Real tests.** Tests use the real thing wherever it can run on a developer's
machine.

| Real | How |
|---|---|
| git and jj | Fixture builders run the actual commands to create repositories in temporary directories. |
| SQLite and the snapshot store | Real files in a temporary data directory. |
| The daemon | Started on a free port and called over HTTP. |
| The agent | The MCP SDK's client, connected through the real stdio shim, running a scripted categorisation; and recordings of real agents, replayed the same way (see [Agent trials](#agent-trials)). |
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
every change. Real tests and fast tests are both wanted. When the two pull apart,
the test wins: a necessary test stays, however long it takes, and the work goes
into making it faster, not into removing it. These are the means of having both:

- Most logic lives in the pure core, where a test takes milliseconds. The slower
  layers check wiring, not rules.
- Fixture repositories are built once per run, keyed by the script that builds
  them, and copied for each test.
- Nothing is shared: no fixed ports, no global state, a temporary data directory
  per test. Every test can run in parallel with every other.
- The daemon starts in-process and takes its data directory as an argument, so a
  test gets its own in a few milliseconds.
- Journey tests run against one production build, in one browser, each with a
  daemon of its own started in its worker's process in a few milliseconds, with a fresh
  browser context per test.
- No sleeps. Tests wait on events or conditions and take time from the `Clock`.
- Slow extras stay out of the per-commit run: the live GitHub suite, other
  browsers and the large-repository measurements. They run on a schedule and
  before a release.

Each type of test has a time limit, as guidance:

| Type of test | Guidance for one test |
|---|---|
| Core | 250 ms |
| Integration | 3 seconds |
| Journey | 20 seconds |

- A test over its limit is reported as a warning, not a failure. Treat the warning
  as a prompt to look for a faster way to test the same thing, or to move the
  test to the layer whose limit fits it. If neither is possible, the test stays.
- There is no limit on the whole suite. `pnpm verify` prints its total time and
  its slowest tests, and warns when the run has become unreasonably long, so a
  slowdown is seen in the commit that causes it.
- A much higher hard timeout remains on every test, only so that a test that
  hangs fails instead of blocking the run.

## Agent trials

The viewer takes the agent's overview and section summaries from the frame of
the version on screen. `src/lib/ui/viewer/agent-markdown.ts` renders Markdown
with raw HTML escaped and link and image destinations discarded, so agent prose
cannot make browser requests. The shop trial opens the report before sorting
and checks that the same page shows the agent's writing when it arrives.

The viewer checks a stamp for the pinned revision before fetching a frame.
Settings and writes to other Delves on the same connection leave the stamp alone.
An external SQLite write invalidates it conservatively. Slice and group ticks
compare the frame's sorting stamp inside the write transaction. Part reads and
search use a separate assignment stamp, checked in the same read transaction as
the rows they use. Editing a summary keeps loaded parts. Regrouping loads them
again, keeping the viewport and keyboard focus by their respective places.
The part the reader was in goes back to its offset once it and the open parts
near the screen have their lines, so their loading placeholders, shorter than
what replaces them, do not move it; if the reader was inside an open large
part, the viewport waits for its replacement's chunk placeholders. A regroup
that comes before that is done keeps the place still being restored. Reader
input or another handover cancels that restoration.

The agent trials (`tests/agent-trials/`) put real coding agents, Claude Code and
Codex, in front of our MCP server and the skill, on fixture repositories, and record
what they do. A trial is the test of the agent interface that no scripted test can be:
whether a model that has read nothing else understands the tools, the answers and the
refusals, and sorts a diff the way a reviewer would want. Its results, and what was
changed because of them, are in [tests/agent-trials/README.md](../tests/agent-trials/README.md).

- **Run by hand, never in `pnpm verify` or CI.** A real trial spends the project
  owner's Claude or ChatGPT subscription; run one when the tools, their answers or
  the skill change in a way an agent would notice. `pnpm trials:run --agent claude
  --fixture ledger` runs one; `--agent codex`, `--fixture shop` and
  `--without-skill` choose the others. `--agent scripted`, the scripted
  categorisation behind the same proxy, costs nothing and is for working on the
  harness. The CLI must be installed and logged in.
- **Nothing of the person's reaches the agent but its login.** The harness runs it
  headless in a copy of the fixture outside this repository, with a home folder of
  its own holding only a link to the CLI's login, our MCP server only and the skill
  when asked for, within a time limit. Claude Code has no shell and may read only
  the copy; Codex's commands run in a sandbox that writes nothing and reads only the
  copy and the system's own folders; neither gets a flag that skips permissions or
  the sandbox. What each rule does and does not hold back is in the
  [results](../tests/agent-trials/README.md#what-the-agent-may-do). However the run
  ends, even interrupted, the CLI and what it started are stopped and the link and
  the temporary folder removed. The recording lists what the session loaded.
- **Recording again.** A trial writes `tests/agent-trials/recordings/<fixture>.<agent>[.no-skill].json`,
  replacing the earlier one, and the agent's own transcript to the ignored
  `tests/agent-trials/transcripts/`. Read both, compare the recording with the one in
  git, and commit it with what you changed because of it. Recordings are public:
  `pnpm verify` fails on one that holds a home folder, a user name, an email
  address, a token, a temporary path or an entry code.
- **Replay.** `pnpm verify` sends every recording's calls, in order, through the real
  shim to a real daemon on the same fixture, with the trials' fixed clock and
  sequential ids. A call the tools now accept or refuse otherwise fails it, naming the
  recording and the call; so does a final sorting that differs. A recording made
  with an older tool surface or skill (its `hashes`), and one whose answers are
  worded differently now, are listed among `pnpm verify`'s warnings with the command
  that records them again; neither fails it.
- **Screenshots.** A recording can also have a journey,
  `tests/journeys/trial-<fixture>-<agent>.journey.ts`, which replays it on the
  journey's daemon (`journey.agentTrial`) and takes the page's steps like any
  journey; its images are kept and checked like the others. Which recordings
  have one yet, and why the others do not, is in the results.

## Checking the experience

**Open file** uses the pinned revision’s trees. The daemon matches names from
the head tree and includes deleted files from the base. The file route returns
at most 200 lines per request and the colours route can colour an exact path on
either side. The reader uses a shallow history entry so Back restores the Delve
and its current place. Forward reads the revision in the file address. A jump
from that reader opens the matching revision of the diff if it differs from
the one already on screen.

The first principle is checked, not assumed.

- **Journey tests read the page as a person does.** They find controls by their
  visible label and role, not by hidden test ids. A button with an unclear or
  missing label fails the test.
- **The first-run journey (J0) has a budget.** From a machine with only Node and
  git, to reading a diff: one command. From there to a finished review on the
  clipboard, using only what the page shows.
- **Accessibility is checked by how a journey works**: every journey is completed
  with the keyboard only, finds each control by its role and visible name, and
  checks where the focus is. Journeys do not run an automated accessibility scan;
  do not add one. Contrast and the like are considered when a screen is designed
  and when its screenshots are looked at.
- **Speed has budgets**, measured on a large fixture diff: time to first readable
  content, and time to move to the next file. Like test times, they are guidance:
  going over one is reported as a warning in `pnpm verify`, not a failure, because
  a slow or busy machine must not fail a correct commit.
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

## Tooling

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
