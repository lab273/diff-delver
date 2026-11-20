# diff delver: design

Status: draft for discussion. Nothing here is built yet.

This document covers what the tool does and why. How the code is written, tested
and committed is in the [README](../README.md) and is not repeated here.

## 1. What it is

diff delver helps a human review a diff. An LLM agent sorts the diff into logical
sections and explains each one. The human reads, ticks off what they have reviewed,
comments, flags lines, and hands the review back to an LLM.

The agent organises and annotates the diff. The human does the reviewing.

### 1.1 The first principle: it must be easy

User experience comes before everything else in this document. diff delver has to
be intuitive, easy to use, and quick for anyone to pick up, including someone who
has never seen it and has not read any documentation.

When ease of use conflicts with a feature, with implementation convenience or with
the purity of the model, ease of use wins. A feature that cannot be made obvious is
cut or postponed.

What this commits us to:

1. **One step to start.** One command in a repository opens the browser on the
   current changes, with no arguments and no configuration. The package is not
   published to npm, so that command runs diff delver straight from its GitHub
   repository or from a local clone. With an agent, the
   user asks in their own words and gets a link back as the first thing.
2. **Nothing to learn twice.** Where GitHub's diff view already has a convention
   (colours, the `+` button on a line, the tick on a file), we use it.
3. **Plain words.** The screen never shows our internal terms. Section 8.5 lists
   what the reviewer sees instead.
4. **Always a next step.** Every screen shows where you are, how much is left and
   one obvious thing to do next. "Next unread" is always one click or one key away.
5. **Nothing hidden.** Every action has a visible control. Keyboard shortcuts and
   drag gestures are faster paths to something a button also does.
6. **Usable at once, never blocked.** The page opens immediately and works while
   the agent is still sorting, while sizes are being measured and with no agent at
   all. Waiting states say what is happening and how far along it is.
7. **No lost work, no ceremony.** Everything saves as you go. A review starts by
   itself when you write the first comment. Ticks, dismissals and resolutions can
   be undone. The only confirmations are for deleting.
8. **Errors that help.** Every error says what happened and what to do next, in a
   sentence a newcomer can act on.
9. **Sensible defaults, few settings.** The default view is right for most people.
   Options sit out of the way and are remembered.
10. **For everyone.** Fully usable by keyboard and screen reader, never colour
    alone to carry meaning, light and dark themes, readable on a laptop screen.

Section 8.1 says how this is designed in. The README says how it is checked.

### 1.2 Three rules of the model

Three rules shape the data model and the agent interface:

1. **The server owns the diff.** It reads the diff from the source itself. The agent
   never supplies diff content, only labels for it.
2. **Coverage is arithmetic, not trust.** Every changed line sits in exactly one
   bucket: a section, `Ignored`, or `Uncategorised`. The server computes what is left
   over, so an agent that skips something cannot hide it.
3. **Pointers, not content.** Whenever the agent refers to code (a note, an answer,
   extra context), it gives a path and line range. The server fetches and renders the
   code. Agent-written text is always shown as agent-written.

## 2. Decisions so far

| Topic | Decision |
|---|---|
| Deployment | Local-first. One daemon on the reviewer's machine, no accounts. |
| Stack | SvelteKit (Svelte 5, TypeScript, `adapter-node`), as one package. |
| Distribution | Not published to npm. It is run from the GitHub repository or a local clone. |
| Sources in v1 | Local git, Jujutsu (jj), GitHub pull requests. |
| Agent access | An MCP server plus an Agent Skill. Works with subscription models because the agent calls in; the server never calls an LLM. |
| Agent loop | Live queue: reviewer requests wait for an attached agent. If none is attached, the request can be copied to the clipboard. |
| Breakdown editing | Read-only in the UI. Reviewer-requested regrouping is out of scope for now. |
| Reviewed unit | A file's part within a section (a "slice"). |
| Tests | The agent records which lines are tests and which section they cover. The reviewer toggles between "with their section" and "separate". |
| Agent findings | Allowed as labelled notes, separate from human comments. |
| Diff updates | Carry over: unchanged lines keep their section, review state and comments. |
| Visual diffs in v1 | Image file diffs and snapshot-test images. |
| Review output | Clipboard, MCP tool, GitHub PR review, file. |
| A single review | One submitted batch of feedback against one revision. A report collects many. |
| Handing over | Submitting is the only way to copy or send a review, so every hand-over is recorded. No "copy draft". |
| Drafts | Private. No MCP tool returns an unsubmitted review. |
| Retention | Reports, reviews and snapshots are kept indefinitely for now. |
| Snapshot storage | diff delver's own git object store, one per repository. Nothing is written to the reviewed repo. |
| Line sharing | A changed line belongs to exactly one section. Other sections can cross-reference it. |
| Agent notes | Secondary: labelled, dismissible, hideable, and left out of exports unless promoted. |
| SQLite | Node's built-in `node:sqlite`. No native dependency. |
| Node | Reviewers need the current LTS line (Node 26 at the time of writing). The built-in SQLite module was checked on 26.13.1. |
| User experience | The first principle. Ease of use wins over features, convenience and model purity (1.1). |
| Disk usage | The UI shows roughly how much space each report and each snapshot takes. |

## 3. Architecture

```
  agent (Claude Code, Codex, Cursor, ...)            reviewer's browser
        │ stdio                                            │ HTTP + SSE
        ▼                                                  ▼
  diff-delver mcp  ── HTTP ──►  diff-delver daemon (SvelteKit, 127.0.0.1)
  (thin stdio shim)             ├─ /mcp        MCP over streamable HTTP
                                ├─ /api, SSE   UI data and live updates
                                ├─ web UI      SvelteKit pages
                                ├─ core        snapshots, lines, coverage, review
                                ├─ sources     git │ jj │ github
                                └─ store       SQLite
                                       │
                                       ▼
                  diff delver's own git object store, one per repository
```

One daemon per user serves every report. It writes a lockfile with its port and a
random token.

Commands:

- `diff-delver` with no arguments opens the browser on the most likely diff: the
  uncommitted changes if there are any, otherwise the current branch or jj change
  compared with the main branch. If more than one is plausible, the browser shows
  a short chooser instead of the command line asking questions.
- `diff-delver open <source>` opens a specific source: a range, a jj revset or a
  pull request URL.
- `diff-delver setup` connects the MCP server and the skill to the coding agents
  it finds on the machine and says what it did. One command, run once.
- `diff-delver mcp` is what agents launch. It starts the daemon if needed and
  proxies stdio MCP to `/mcp`. Clients that speak HTTP MCP can connect directly.
- `diff-delver serve` runs the daemon in the foreground.

### 3.1 Every source becomes two git trees

The core handles one shape of input: a base tree and a head tree in a git object
store that diff delver owns. Each source adapter reduces its input to that.

| Source | How it becomes two trees |
|---|---|
| git range or commit | Resolve the merge base and head commit. |
| git working tree or staged | Write a tree from a temporary index, so untracked files are included and `.gitignore` is respected. The new objects are written to diff delver's store, not the repo. |
| jj revision or revset | Resolve to commit ids in the backing git store. The jj working copy is already a commit. |
| GitHub PR | Fetch the PR head and its merge base into diff delver's store, as a blobless fetch that pulls file contents on demand. A local clone of the same repo, if there is one, is used to avoid downloading what is already on disk. Base is the merge base, as GitHub shows it. Auth comes from `gh` or `GITHUB_TOKEN`. |

This buys three things:

- A snapshot is immutable. A working-tree review does not shift while files are
  edited underneath it.
- One diff command for all sources, so line identity is consistent: git's
  plumbing (`diff-tree`) with every option pinned (histogram algorithm, rename
  and copy detection, full object ids), so the result does not depend on the
  reviewer's git configuration.
- Any file in either tree is readable, which is what makes exploring non-diff code
  work the same way everywhere, including for a PR with no local checkout.

### 3.2 The snapshot store

Snapshots must outlive the reviewed repository's garbage collection, and reports
are kept indefinitely. So diff delver keeps its own bare git store per repository
in its data directory and never writes to the repo being reviewed.

- For a local source, the objects reachable from the two trees are copied into the
  store. History is not copied.
- Each snapshot is pinned by a ref inside the store. Deleting a report removes its
  refs and lets the store collect the objects.
- Git stores content by hash, so successive snapshots of one repository share
  everything that did not change.

The cost is disk space and a copy step that takes longer on large repositories.
Both trees are whole, so opening any file and searching the tree keep working for
as long as the report exists.

Adapter interface:

```ts
interface DiffSource {
  /** Cheap identity check, used to notice that the diff has changed. */
  resolve(spec: SourceSpec): Promise<{ store: string; base: TreeId; head: TreeId; label: string }>;
  /** Source-specific extras: PR title and description, jj change id, commit messages. */
  describe(spec: SourceSpec): Promise<SourceMeta>;
}
```

A patch-file source does not fit this shape (no surrounding content). It is out of
v1.

## 4. The diff model

### 4.1 Lines are the unit

The smallest unit is a changed line: one added line or one deleted line. Context
lines belong to nobody. A file whose change has no lines (pure rename, mode change,
binary file, image, empty file) has a single file-level unit instead.

Call these units **change lines**. Each one is addressed by file, side and line
number, which is stable within a snapshot:

```
src/auth/session.ts  +40..+62     added lines 40 to 62 of the new file
src/auth/session.ts  -38..-45     deleted lines 38 to 45 of the old file
assets/logo.png      (file)       the file-level unit
```

Each change line has:

- a **bucket**: one section, `Ignored`, or `Uncategorised`. Exactly one.
- a **role**: `code`, `test` or `snapshot`.
- a **reviewed** mark, set only by the human.

Assignments are stored as line ranges, not as a row per line.

### 4.2 Buckets

- **Sections** are created by the agent. Each has a title, a Markdown summary and a
  position in the reading order.
- **Ignored** holds everything that is deliberately not reviewed. Each entry records
  who put it there and why: a built-in rule (lockfile, `linguist-generated` in
  `.gitattributes`, vendored path, minified file), a project pattern from
  `.diff-delver.toml`, or the agent with a written reason. `linguist-generated`
  cannot be told from a path, so the server reads the attributes of the head tree
  and passes the matching paths to the model.
- **Uncategorised** is owned by the server. It holds whatever nobody has assigned.
  It is always visible in the UI when non-empty.

With no agent at all, everything sits in `Uncategorised` and the tool is still a
working diff viewer with review tracking.

### 4.3 Slices

A **slice** is one file's change lines within one section. A file split across
three sections has three slices. Slices are what the reviewer sees and ticks.

When a slice is drawn, a hunk may contain change lines that belong to a different
section. Those lines are shown muted with a chip linking to their section. They are
never hidden, so the file always reads correctly, and they do not count towards
this slice.

A changed line has one home. When it also matters to another section, the agent
adds a cross-reference there: a path and line range that the UI shows as a link to
the line in its home section. Cross-references do not affect coverage or ticks.

The agent may split a run of adjacent `-`/`+` lines between sections. The server
allows it and reports it as a coverage warning, because it usually reads badly.

### 4.4 Tests

The server guesses `role: test` from path conventions and project patterns. The
agent can correct it per file or per line range, which covers in-file tests such
as a Rust `#[cfg(test)]` module.

The agent assigns test lines to the section they cover, like any other line. Tests
that cover nothing in particular go in a section of their own.

The reviewer's toggle is then a pure view change:

- **With their section**: slices appear where they were assigned.
- **Separate**: every `test` and `snapshot` line that sits in a section is lifted
  into a `Tests` group, sub-grouped by the section it came from. Test lines that
  are ignored or not yet sorted stay where they are, so "not sorted yet" always
  means the same thing.

The underlying assignment does not change, and neither does review state.

## 5. Review state

All of it belongs to the human. No MCP tool can write it. Section 6.3 covers how
this state is grouped into reviews.

- **Reviewed.** The UI ticks a slice. Underneath, the mark is stored on each change
  line. A slice is ticked when all its lines are marked; a file when all its slices
  are; a section likewise. Storing it per line means a diff update moves review
  progress with the lines instead of discarding it.
- **Threads.** Anchored to a line range on either side of a file, or to a file, a
  section or the whole report. The anchor may be a non-diff line in the head tree.
  Kinds:
  - `comment`: human text on a range.
  - `flag`: a one-click "look at this again" marker, with optional text.
  - `note`: agent-authored, with a label of `possible bug`, `risk`, `question` or
    `info`. Notes are secondary to the human's own reading. They are visibly
    marked as agent-written, can be dismissed one by one or hidden all at once,
    and are left out of a submitted review unless the reviewer promotes them.
  - `request`: a question or instruction for the agent (section 7).
- **Progress** counts slices and lines reviewed, per section and overall. `Ignored`
  is excluded from the total and shown beside it.

## 6. Reports, revisions and reviews

Three things nest inside each other:

- A **report** is one source followed over time, for example one pull request.
- A **revision** is one frozen state of that report: a snapshot of the diff plus
  the breakdown of it into sections.
- A **review** is one round of human feedback, submitted as a batch against one
  revision. A report collects many reviews, the way a pull request does.

```
report  owner/repo#123
├─ revision 1 ── review 1 (submitted: 5 comments, 2 flags, 14 of 20 slices)
├─ revision 2 ── review 2 (submitted: 1 reply, 3 resolved)
└─ revision 3 ── review 3 (draft)
```

### 6.1 Reports

A report's identity comes from its source:

| Source | Identity |
|---|---|
| GitHub PR | host, owner, repo, number |
| jj change | repo and change id, so an amended change is the same report |
| jj revset or git range | repo and the two ends as written, e.g. `main...feature-x` |
| git working tree or staged | repo and worktree path |

A report is **open** or **closed**. It closes when the PR is merged or closed, when
the diff becomes empty (committed, merged or discarded), or when the reviewer closes
it. `create_report` on a source with an open report resumes it. On a source whose
last report is closed, it starts a new one. This matters most for working-tree
reports, where the same source holds unrelated work from one day to the next.

Closed reports stay in the list and stay readable.

### 6.2 Revisions

When the source changes (new commit, amended jj change, force-push, edited working
tree), the UI shows a banner. The update is applied when the reviewer clicks, never
mid-read.

A revision can be edited by the agent until a review is submitted against it. After
that it is frozen. If the agent changes the breakdown afterwards, for example to
sort lines that were still uncategorised, the server makes a new revision on the
same snapshot. A submitted review always points at the breakdown the reviewer saw.

Applying an update creates a new revision:

1. Take a new snapshot.
2. For each file (following renames), match old change lines to new ones by side
   and text, in order.
3. Matched lines keep their bucket, role, reviewed mark and thread anchors.
4. Unmatched new lines go to `Uncategorised`, marked "new since revision N". An
   attached agent is told there is work to sort.
5. Threads whose lines disappeared are kept and marked outdated, with the old code
   quoted.

A slice with a mix of reviewed and new lines shows as partly reviewed, with a
filter for "only what changed since I reviewed".

### 6.3 Reviews

A review is a draft until it is submitted. A report has at most one draft. It
starts on its own with the first comment, flag or resolution after the previous
submission. Submitting freezes it and the next action starts the next one.

A review can be submitted at any point, including with slices unread. Small,
frequent reviews are the expected way to work with an agent that is fixing things
as you go.

What belongs to a review:

- comments written during it, including replies on threads from earlier reviews
- flags raised and flags cleared
- threads resolved
- agent notes promoted
- an optional summary and verdict

What does not:

- **Reviewed marks.** These accumulate on the report. The review records a copy
  of them at the moment of submission.
- **Requests to the agent and its answers.** These are conversation, not feedback
  to the author. They stay on the report unless the reviewer promotes one.

A submitted review is a self-contained record:

- the revision it was submitted against
- each item with its anchor and the quoted code, captured at submission
- coverage at submission: reviewed ranges, unread slices, uncategorised count
- the exact export text that was handed over
- a delivery log: copied, saved to a path, posted to GitHub (with the review URL),
  fetched by an agent

Threads outlive reviews. A thread belongs to the report and is re-anchored across
revisions; each message in it belongs to the review it was written in. In a later
review an earlier thread is **open**, **changed since** (its lines changed in a
newer revision, so it may have been addressed) or **resolved**. The reviewer
resolves it or replies, and that action is part of the current review.

Drafts are private. No MCP tool returns an unsubmitted review, so an agent never
acts on half-written comments.

### 6.4 History

- **Reports list** (`/`): every report with its source, state, last activity,
  review count and approximate size, filterable by repository.
- **Report timeline**: revisions and reviews in order, as in the diagram above,
  with each snapshot's approximate size.
- **A past review** opens read-only and shows the export text, each item against
  the revision it was written on, each thread's status today, and the delivery log.
  Any destination can be used again from here.
- **As of this review**: the report as it stood at submission, with that revision's
  diff, breakdown and reviewed marks.

Reports, reviews and their snapshots are kept indefinitely for now. Nothing is
removed until the reviewer deletes a report.

Because a review stores its quoted code and export text, it would stay readable
even without its snapshot. That leaves room for a retention rule later (drop the
snapshots of old closed reports, keep every review) without changing the model.

## 7. The agent interface

### 7.1 MCP tools

Reading:

| Tool | Purpose |
|---|---|
| `create_report(source, title?)` | Snapshot a source and return the report id, URL, file counts and what was auto-ignored. Calling it again for the same source returns the existing report. |
| `list_reports()` | Find reports to resume. |
| `get_manifest(report)` | Every file with status, line counts, hunk ids, guessed role and current buckets. Small; read first. |
| `get_diff(report, files?, only_uncategorised?, cursor?)` | The diff as labelled text (`+40`, `-38`, hunk ids), paged by size. |
| `get_file(report, path, side, range?)` | Any file from either tree, for context. |

Writing:

| Tool | Purpose |
|---|---|
| `set_overview(report, markdown)` | What the change does, in reading order. |
| `upsert_sections(report, sections[])` | Create, retitle, summarise and reorder sections, and set each section's cross-references to lines that live elsewhere. |
| `assign(report, items[])` | Put change lines in a section or in `ignored` (with a reason), and optionally set a role. An item names a file, a glob, hunk ids or line ranges. Returns what was accepted, what was rejected and how many lines remain. |
| `get_coverage(report)` | What is still uncategorised, plus warnings: empty sections, oversized sections, split change runs, tests with no section. |
| `add_notes(report, notes[])` | Labelled agent notes on line ranges. |

Live loop and review:

| Tool | Purpose |
|---|---|
| `wait_for_requests(report, timeout?)` | Long-poll. Returns reviewer requests, or an idle status when the timeout passes. Also reports "diff updated" and "review submitted". |
| `answer_request(request, body, references?)` | Reply in the thread. `references` are path and line ranges that the server renders as code excerpts. |
| `get_review(report, review?)` | A submitted review by number, the latest by default: comments, flags, promoted notes, unread slices, and threads still open from earlier reviews. Same content as the clipboard export. |

`assign` example:

```json
{ "report": "r_7f3", "items": [
  { "section": "session-expiry", "file": "src/auth/session.ts", "lines": "+40..+62,-38..-45" },
  { "section": "session-expiry", "file": "src/auth/session.test.ts", "role": "test" },
  { "section": "ignored", "glob": "fixtures/recorded/**", "reason": "Re-recorded HTTP fixtures" }
] }
```

An item with only a file or glob takes whatever in it is still uncategorised, which
keeps large diffs cheap: assign whole files where that is right, and spend line
ranges on the mixed ones.

A line range takes the changed lines inside it. It may span unchanged lines, so
`+40..+62` works when a few of those lines are context. An item is refused only
when all its ranges together contain no changed line, and the refusal names the
nearest changed lines. A range that matches nothing inside an item that otherwise
takes something is reported back but does not refuse the item, so an agent that
copies both sides of a hunk heading for an addition-only hunk still succeeds.
Every answer says how many lines each item took and, when it took none, why.

A path that is not valid UTF-8 is still one file with one exact identity. It is
shown with its odd bytes escaped, and the agent addresses it in that escaped form.

The report is a draft until `get_coverage` shows nothing uncategorised. The UI can
be opened at any time and shows the draft state.

### 7.2 Reviewer requests

From any line range, file or section the reviewer can ask the agent something.
There is one **Ask** box. It takes free text and offers two ready-made questions,
"Explain this" and "Show me related code", so nobody has to choose a request type
first.

The UI shows whether an agent is attached, meaning a `wait_for_requests` call is
open or was recently. If so, the request is delivered and the answer appears in the
thread. If not, the request has a "Copy as prompt" button producing a
self-contained prompt, including the report id, that any agent with the MCP server
can act on.

The long-poll timeout stays below typical client tool timeouts. The skill tells
the agent to call again.

### 7.3 The skill

`skills/diff-delver/SKILL.md`, in the Agent Skills format, also packaged as a
Claude Code plugin together with the MCP configuration. Outline:

1. Work out the source from the user's request and call `create_report`. Give the
   user the URL straight away.
2. Read the manifest, then the diff. Read the PR description or commit messages.
3. Plan sections as a reading order: what a reviewer should understand first.
   Aim for sections a person can hold in their head.
4. Assign whole files first, then line ranges in mixed files. Put each test with
   the section it covers. Give a reason for anything ignored.
5. Call `get_coverage` and repeat until nothing is uncategorised.
6. Write the overview and section summaries. Add notes only where there is
   something specific to say.
7. Stay attached with `wait_for_requests` until the review is submitted, then
   fetch it with `get_review`.

It also says what not to do: do not paste diff content back, do not invent line
numbers, do not describe code you have not read.

## 8. The reviewer interface

### 8.1 How it should feel

This is principle 1.1 applied to the screen.

**The first minute.** A new reviewer lands on the overview: two or three
sentences on what the change does, a progress bar, the list of sections and a
**Start reviewing** button. Nothing else needs to be understood to begin.

**The loop.** Read a section's summary, read its files, tick each one. The next
unread file is always one press away. Finishing a section moves on to the next.
When everything is ticked, the page offers **Finish review**.

**Three things you can do to code.** Select lines and the same small menu always
appears: **Comment**, **Flag**, **Ask**. Selecting is a click on the `+` beside a
line, with shift-click or a drag to extend.

**States explained in place.** Wherever something could puzzle a newcomer, the
page says what it is, once and briefly:

| Situation | What the page says |
|---|---|
| The agent is still working | "Sorting the diff: 340 of 1,200 lines placed. You can start reading." |
| Lines nobody sorted | "Not sorted yet: 3 files. The agent did not place these, so they are listed here." |
| No agent connected | "No agent connected. Copy this request and paste it into your agent." with a copy button |
| The diff changed | "This diff has changed since you opened it. Update to see 3 changed files. Your ticks and comments are kept." |
| Lines from another section | "Shown in *Session expiry*" on the muted lines, as a link |
| Ignored file | The reason beside the file, e.g. "Lockfile" or "Agent: re-recorded fixtures" |

**Speed.** Opening a diff, moving between files and ticking feel instant. Long
diffs are drawn as you scroll. Background work never freezes the page.

**Not shown unless wanted.** Split view, whitespace hiding, the tests toggle,
agent notes on or off, history and storage are each one click away and none is
needed for a first review.

### 8.2 Layout

- **Left rail**: the overview, then sections in reading order with progress,
  then `Tests` (in separate mode), `Uncategorised` (if any) and `Ignored`.
- **Main pane**: the section summary, then its slices. Each slice has a tick, the
  file path, chips for the file's other sections, and the diff.
- **Side panel**: threads, agent notes, the request queue and the draft review.
- **History**: the report's timeline of revisions and reviews (6.4).
- **File tree view**: an alternative to the guided view that lists every file once
  with chips showing where its parts live. This is the direct answer to "is every
  file accounted for".

### 8.3 Reading the diff

- Unified or split, syntax highlighted, optional whitespace hiding.
- Expand context above or below a hunk, or expand to the whole file.
- Open any file in the repo at the base or head tree, not only changed files.
  Search the tree (`git grep` against the snapshot). Jump from an identifier to its
  other occurrences. Proper symbol navigation is out of v1.
- Non-diff lines can be selected, commented on and flagged like any other.
- Drag in the gutter to select a range, then comment, flag or raise a request.
- Keyboard: next and previous slice, tick, comment, flag, expand, toggle tests.

### 8.4 Visual diffs

- **Image files** (PNG, JPEG, GIF, WebP, SVG): side by side, swipe, onion skin and
  pixel difference, with dimensions and file size. SVG also has its text diff.
- **Snapshot-test images**: recognised by path convention (Playwright
  `*-snapshots/`, `__image_snapshots__/`, Paparazzi, and project patterns), given
  `role: snapshot`, and shown next to the test that owns them. They follow the
  tests toggle.

An image is one file-level unit, assigned and ticked like any slice.

### 8.5 Words the reviewer sees

This document uses precise internal terms. The interface does not. This table is
the starting vocabulary, to be adjusted by watching people use it.

| Internal term | On screen |
|---|---|
| report | The diff, named by its source: "Pull request #123", "Uncommitted changes", "feature-x compared with main" |
| revision | "Update 2", with when it arrived and what changed |
| snapshot | Not shown. Its size appears on the update |
| slice | Not named. A split file shows "part 2 of 3" |
| bucket | Not shown |
| `Uncategorised` | "Not sorted yet" |
| `Ignored` | "Ignored", always with the reason |
| role `test`, `snapshot` | "Tests" |
| guided view, file tree view | "By section", "By file" |
| note | "Agent note" |
| request | "Question for the agent" |
| agent attached | "Agent connected" |
| thread status | "Open", "Code changed since", "Resolved" |
| submit | "Finish review" |
| own size | "Frees about 40 MB" |

### 8.6 Finishing a review

The review panel previews the export text. The main button is **Finish and copy**:
one click submits the review (6.3) and puts it on the clipboard, which is the
common case. A menu beside it offers the other destinations. A finished review can
be sent to any of them again from the history.

- **Clipboard**: Markdown written for an LLM.
- **MCP**: `get_review`.
- **File**: Markdown or JSON at a chosen path.
- **GitHub**: a pull request review under the reviewer's own identity, created as
  pending by default. Comments on lines GitHub cannot anchor (non-diff lines) go
  in the review body.

Clipboard format:

````markdown
# Review 2 of owner/repo#123 (revision 2, head 4c1d9ae)

## Still open from earlier reviews

### src/auth/tokens.ts:88-90 (new), from review 1, unchanged
Refresh tokens are logged here.

## Comments

### src/auth/session.ts:40-46 (new)
```ts
if (session.expiresAt < now) {
  ...
```
This drops the grace period. Was that intended?

## Flagged for another look
- src/auth/tokens.ts:112 (new)

## Not reviewed
- Section "Migration": db/migrate/0042_sessions.sql
````

The quoted code is inserted by the server from the snapshot.

## 9. Storage and safety

- SQLite in the user's state directory. Reports, revisions, sections, assignments
  (as ranges), reviewed ranges, threads, messages, reviews with their frozen items
  and export text, and an append-only event log that feeds live updates.
- One git object store per reviewed repository in the data directory (3.2).
- Review state is personal and never written into the repository.
- The daemon binds to `127.0.0.1`, checks `Host` and `Origin`, and requires its
  token.
- Agent Markdown is sanitised. Raw HTML is not rendered.
- Diff content is untrusted input to the agent. The skill says to treat it as data.
- Human-only state (reviewed marks, comments, flags, the review) has no MCP write
  path.

### 9.1 Disk usage

Reports are kept indefinitely and each repository's store holds whole trees, so
the UI has to show where the space goes.

Snapshots of one repository share objects, so sizes do not simply add up. Each
snapshot and each report therefore gets two figures:

- **Own**: what deleting it would free. These are the objects nothing else in the
  store refers to.
- **Shared**: what it uses in common with other snapshots or reports of the same
  repository.

A report's figure also includes its rows in SQLite, which are small.

Where it is shown:

- the reports list, one figure per report (own, with shared on hover)
- the report timeline, one figure per snapshot
- a **Storage** page: each repository's store with its real size on disk, the
  database size, the reports inside each store sorted by size, and delete
- the delete confirmation, as "frees about 40 MB"

How it is measured:

- A store's total is its real size on disk.
- Per-snapshot figures come from git's own per-object disk sizes, summed over the
  objects reachable from the snapshot's two trees. Git compresses objects against
  each other, so these are estimates and are labelled "about".
- Figures are computed in the background when a snapshot is added or removed and
  cached. They never block opening a report.
- Space is returned to the disk when the store is next collected, which deleting a
  report triggers.

## 10. User journeys

Each journey is a named scenario, written from the reviewer's side. The README
says how journeys are tested.

| # | Journey | The reviewer can |
|---|---|---|
| J0 | First run | start from a machine with only Node and git, run one command, and finish a first review using nothing but what the page shows |
| J1 | Review local changes with an agent | ask an agent for a report, open it, read section by section, tick slices, comment, submit and paste the review back |
| J2 | Open a diff with no agent | run `diff-delver`, see everything under "Not sorted yet", and still tick, comment and submit |
| J3 | Everything is accounted for | see files the agent skipped under `Uncategorised`, see why each ignored file is ignored, and find every file once in the file tree view |
| J4 | One file, several sections | read a file's slices in different sections, see the other sections' lines muted, and follow a cross-reference |
| J5 | Tests with or apart | switch tests between their sections and a separate group without losing ticks |
| J6 | Comment and flag | comment on a range, flag a line, and do both on a non-diff line reached by expanding context or opening the whole file |
| J7 | Ask for more context | get an answer with code excerpts from an attached agent, and copy the request as a prompt when none is attached |
| J8 | The diff changes mid-review | apply an update, keep ticks and comments on unchanged lines, and see new lines waiting to be sorted |
| J9 | A second round | see earlier threads as open, changed or resolved, reply and resolve, and submit review 2 |
| J10 | Look back | open a past review, read exactly what was handed over, and see the report as of that review |
| J11 | Review a GitHub PR | open a PR by URL with no local clone and post the review as a pending GitHub review |
| J12 | Review a jj change | open a change, amend it, and continue in the same report |
| J13 | Visual changes | compare a changed image in each mode and see a snapshot image beside its test |
| J14 | Agent notes | hide all notes, dismiss one, promote one into the review |
| J15 | Disk space | see what each report and snapshot takes, delete a report and see the space freed |

## 11. Build order

All of this is v1; the order is chosen so each step is usable. Each step ends with
its journeys passing.

1. **Core and viewer.** Snapshots from local git, the line model,
   coverage, SQLite, the no-argument start, the overview, file view, context
   expansion, ticks. J0 as far as ticking; part of J2.
2. **Agent categorisation.** MCP server, stdio shim, `setup`, skill, sections, `assign`,
   coverage, guided view, `Ignored`, tests toggle. J3, J4, J5.
3. **Review.** Comments, flags, agent notes, draft and submit, clipboard and file
   export, `get_review`, reports list, past reviews, sizes and the Storage page.
   J0, J1, J2, J6, J14, J15.
4. **Live loop.** Request queue, agent presence, "Copy as prompt". J7.
5. **Revisions.** Change detection, carry-over, thread status across reviews,
   report timeline and "as of this review". J8, J9, J10.
6. **More sources.** jj, GitHub PRs, posting a GitHub review. J11, J12.
7. **Visual diffs.** Image viewer and snapshot-image pairing. J13.

## 12. Requirements check

| # | Requirement | Where |
|---|---|---|
| 1 | Every file accounted for | Three buckets, server-computed coverage, file tree view (4.2, 8.2) |
| 2 | A file in several sections, by line | Change lines and slices (4.1, 4.3) |
| 3 | Subscription LLMs via skill and MCP | Section 7 |
| 4 | Track reviewed files | Slice ticks stored per line (5) |
| 5 | Flag or comment on lines | Threads (5, 8.3) |
| 6 | Explore adjacent non-diff lines | Context expansion, whole-tree file viewer (3.1, 8.3) |
| 7 | More context on demand | Requests and `references` (7.2) |
| 8 | Copy review for an LLM | Reviews and finishing (6.3, 8.6) |
| 9 | Visual diffs | Section 8.4 |
| 10 | Tests with sections or separate | Roles and the toggle (4.4) |

## 13. Out of scope for now

- **Regrouping at the reviewer's request.** The breakdown is read-only in the UI
  and there is no "regroup" request. The agent sets the breakdown when it builds
  the report and when it sorts new lines after a diff update.
- **Patch-file sources.** They have no surrounding content.
- **Symbol navigation.** Search and occurrence jumps only.
- **Sharing and multiple reviewers.** One reviewer, one machine.
- **Retention rules.** Everything is kept until a report is deleted.

## 14. To verify before building

- Copy time and disk use of the snapshot store on a large repository.
- How close the per-snapshot size estimates are to the space actually freed.
