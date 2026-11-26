# diff delver: design

Status: draft for discussion. Nothing here is built yet.

This document covers what the tool does and why. How the code is written, tested
and committed is in the [developer guidance](DEVELOPING.md) and is not repeated here.

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
   published to npm, so that command runs the newest release from GitHub, a small
   download with nothing to build; a local clone works too. With an agent, the
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

Section 8.1 says how this is designed in. The developer guidance says
[how it is checked](DEVELOPING.md#checking-the-experience).

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
| Distribution | Not published to npm. It is run from a built package attached to a GitHub release, or from a local clone. A release is made only by a workflow a person starts by hand, which runs every test before it packages anything. |
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

One daemon per data directory, which by default means one per user, serves every report. It writes a lockfile with its port and a
random token.

Commands:

- `diff-delver` with no arguments opens the browser on the most likely diff: the
  uncommitted changes if there are any, otherwise the current branch or jj change
  compared with the main branch. If more than one is plausible, the browser shows
  a short choice instead of the command line asking questions.
- `diff-delver open <source>` opens a specific source: a range, a jj revset or a
  pull request URL.
- `diff-delver choose` opens a page for the repository it is run in, to choose
  commits or a whole branch to review (3.1). The start page links to it too, and
  so do a Delve's page and the list of Delves, for every repository a Delve was
  opened in (8.2).
- `diff-delver setup` connects the MCP server and the skill to the coding agents
  it finds on the machine and says what it did. One command, run once.
- `diff-delver mcp` is what agents launch. It starts the daemon if needed and
  proxies stdio MCP to `/mcp`, telling the daemon which folder it was started in.
  `/mcp` keeps no session, so when the daemon stops or is replaced the shim finds
  or starts it again and sends the message again; the agent never notices. Clients
  that speak HTTP MCP can connect directly.
- `diff-delver serve` runs the daemon in the foreground.

### 3.1 Every source becomes two git trees

The core handles one shape of input: a base tree and a head tree in a git object
store that diff delver owns. Each source adapter reduces its input to that.

| Source | How it becomes two trees |
|---|---|
| git range or commit | Resolve the merge base and head commit. |
| git working tree or staged | Write a tree from a temporary index, so untracked files are included and `.gitignore` is respected. The new objects are written to diff delver's store, not the repo. |
| jj revision or revset | Resolve to commit ids in the backing git store. The jj working copy is already a commit. |
| GitHub PR | Fetch the PR head and the base branch into diff delver's store, borrowing a local clone of the same repo, when it is a whole clone, so only what it lacks is downloaded. Base is the merge base, as GitHub shows it. Auth comes from `gh` or `GITHUB_TOKEN`. |

**Pull requests, as built.** A repository whose remote is on GitHub offers its
open pull requests on the choose page, asked of GitHub only when the person
presses the button, and `diff-delver open <pull request address>` opens one. The
pull request is fetched into diff delver's own store, borrowing the local clone's
objects so only what it lacks is downloaded, and nothing is written to the clone.
The sign-in is `gh`'s, or `GITHUB_TOKEN`, and is kept nowhere. A pull request
opens from any clone with a remote on its repository, and a clone of a fork lists
the pull requests of its `upstream` first. Opening it again, from any clone,
resumes the same Delve, whose versions all live in one store, and a push to it,
or a change of its base, is the Delve's next version, offered as any update is.
What it downloaded is kept in the store while its Delve exists, so an update asks
GitHub only for what is new, even from a clone that is out of date, partial or
shallow; a first open from a partial or shallow clone still downloads the history
it needs, once.
The page asks GitHub about that at most once a minute, or every five minutes
without a sign-in, and when GitHub says to wait, everything waits until it says.
A merged or closed pull request has nothing left to review, and the command says
so, or why one could not be opened, without opening a page. For now a pull
request opens only from a local clone of its repository; with no clone, and on
GitHub Enterprise, it does not yet. The agent reads its title and description as
quoted text.

**Choosing commits.** The choose page lists a repository's branches and, for the
one chosen, its commits, newest first, each with when it was made and how many
lines and files it changes. What a person picks there is always one of the sources
above, because a diff is between two points in history:

- One commit ticked is the `commit` source, named in the report by its subject.
- Two or more are always one unbroken run of commits next to each other: ticking a
  second commit takes in every commit between the two, and unticking one in the
  middle keeps the newer part and says why. A run is a `range` from the parent of
  its oldest commit to its newest, written as commit ids, so it never moves. From
  the repository's first commit, the range starts at git's empty tree. Its name,
  how many commits it is and the subjects of its oldest and newest (8.5), is read
  once when it is opened and kept with the report. Commits that are not next to
  each other are not offered as one diff.
- A whole branch is the branch compared with the main branch, the same `range` the
  no-argument start opens.

The list is the branch's first-parent history, so it is one line and any run in it
is a valid pair of points; a merge is one row, with its size against its first
parent. One branch is the main branch, the one every count and comparison names
(`origin/main` when the remote has one), and the list marks where the chosen branch
left it. History is read a page at a time, never whole.

Whether the local copy is out of date is known offline only as when it last fetched,
which the page always shows. What the remote has now needs the network, so it is a
button: it asks the remote which commits its branches are at (`git ls-remote`) and
says which branches have commits this copy has not fetched, with the command to
fetch them. diff delver never fetches, because a fetch writes to the repository,
and it makes no network call the person did not ask for.

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

Every source offers the same three things:

- **A fingerprint**, cheap to compute, for noticing that the diff may have changed.
  It is not the trees themselves: for a working tree those cannot be known without
  taking a snapshot. It may raise a false alarm, so a new snapshot's trees are
  compared with the old ones before the reviewer is told anything changed.
- **A snapshot**: the base and head trees written into diff delver's store.
- **A description**: the source in plain words, plus what is specific to it (a pull
  request's title and description, a jj change id, commit messages), and anything
  that could not be included, which the reviewer is shown.

A patch-file source does not fit this shape (no surrounding content). It is out of
v1.

## 4. The diff model

### 4.1 Lines are the unit

The smallest unit is a changed line: one added line or one deleted line. Context
lines belong to nobody. A file whose change has no lines (pure rename, mode change,
binary file, image, empty file) has a single file-level unit instead.

A file also has a file-level unit, beside its lines, whenever something about the
file itself changed: its name, its mode (such as becoming executable) or its kind
(a file becoming a link). Those changes matter, a line-by-line reading cannot show
them, and so they are sorted, shown and ticked like any other change.

Call these units **change lines**. Each one is addressed by file, side and line
number, which is stable within a snapshot:

```
src/auth/session.ts  +40..+62     added lines 40 to 62 of the new file
src/auth/session.ts  -38..-45     deleted lines 38 to 45 of the old file
assets/logo.png      file         the file-level unit
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

### 4.3.1 Reading order within a section

By default a section's slices are read in path order. The agent may instead give a
section a **reading order**: a list of steps, each a file, or some of a file's
change lines in that section, so the order follows the code rather than the
alphabet: a class's definition before its first use, a type before the function
that takes it, the change before its test. A file's lines in one section may be
spread over several steps, as the reading needs; each step is drawn as a part of
its own and ticked on its own, and the file's other lines in the section are shown
muted, as another section's are, with a link to their step.

Each step may carry a short note from the agent, a sentence or two that says what
to look at in it and why it comes here. Notes are agent-written and shown as such,
quieter than the section's summary; they guide the reading and never judge the
code.

Lines of the section that no step names follow the steps, in path order, so
nothing is ever left out of the reading. A reading order is part of the sorting:
it is set on the version the agent read and carried to the next version with the
lines it names, as cross-references are; a step whose lines are all gone is
dropped, and new lines go after the steps until the agent orders them.

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

**A diff's size counts tests apart.** Wherever a diff's size is shown in lines,
the lines with the role `test` or `snapshot` are counted beside the rest and not
in it, so the main count is the code to read and the two add up to the whole.
On a Delve the stored role counts, so an agent's correction changes it; before
there is a Delve, as on the choose page, the same path rule the first version
uses decides. Binary files have no lines, so the size also says how many binary
files are added, removed and changed, with their sizes in bytes, on a Delve's
page, in the list of Delves and from the command; the choose page leaves them
out, because git's per-commit counts do not give their sizes.

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
    As built, notes are kept apart from the draft and belong to the version
    they were written on; a later version says how many an earlier one has
    waiting. Promoting one makes a draft comment of the reviewer's that quotes
    the agent's words and says they came from a note, which the reviewer can
    then edit. Dismissed notes come back all at once.
  - `request`: a question or instruction for the agent (section 7).
- **Progress** counts slices and lines reviewed, per section and overall. `Ignored`
  is excluded from the total and shown beside it.

## 6. Reports, revisions and reviews

Three things nest inside each other:

- A **Delve** follows one source over time, such as a pull request. The data
  model and MCP API call it a **report**.
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
| a single commit | repo and the commit as written |
| git working tree or staged | repo and worktree path |

An end written relative to where a worktree is, such as `HEAD`, means a different
commit in each worktree, so the worktree is then part of the identity too.

A report is **open** or **closed**. `create_report` on a source with an open report
resumes it. On a source whose last report is closed, it starts a new one. This
matters most for working-tree reports, where the same source holds unrelated work
from one day to the next.

A report never closes under the person reading it. When its source has nothing left
to review (the changes were committed, merged or discarded, or the PR was merged or
closed), the page says so in a banner, keeps showing what was being read, and
offers the next step: close it, or open what the changes became, such as the commit
they went into. It closes when the reviewer closes it, or when its source is next
opened and has nothing to review.

Closed reports stay in the list and stay readable.

### 6.2 Revisions

When the source changes (new commit, amended jj change, force-push, edited working
tree), the UI shows a banner. The update is applied when the reviewer asks for it,
never under them while they read: either they press **Update** on the banner, or
they run the command for that source again, which is itself a request to see the
files as they are now. Either way the page then says what the update changed: how
many files changed, how many lines are new to review, and that ticks and comments
on unchanged lines were kept.

A revision can be edited by the agent until a review is submitted against it. After
that it is frozen. If the agent changes the breakdown afterwards, for example to
sort lines that were still uncategorised, the server makes a new revision on the
same snapshot. A submitted review always points at the breakdown the reviewer saw.

Applying an update creates a new revision:

1. Take a new snapshot.
2. Decide which lines are the same line as before. A line is the same when git's
   own comparison of the two versions leaves it unchanged: the two heads for added
   lines, the two bases for deleted lines, following renames. Only edits elsewhere
   may have moved its number. A line made only of punctuation or white space, such
   as a lone brace, keeps its state only when a line with real content beside it in
   the same change kept its state too, so such lines are never matched across
   unrelated code. When in doubt a line counts as new: a wrong "reviewed" would
   hide code from the reviewer, and a wrong "new" only costs a second look.
3. Matched lines keep their bucket, role and thread anchors. A matched line keeps
   its reviewed mark only when nothing within three lines of it, in the diff as
   the reviewer reads it, changed between the two versions: a line added, a line
   removed, or an edit to the unchanged lines shown around it. Familiar lines that now sit
   inside changed code, such as an unchanged error check under a replaced call,
   are read again in their new surroundings.
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

- **Reviewed marks.** These accumulate on the report: they are stored with each
  revision and carried forward to the next, so the report's progress is that of
  its current revision. The review records a copy of them at the moment of
  submission.
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
acts on half-written comments. For now, saved comments stay at their original
file, side and line range when a Delve is updated. The draft lists them with
the version they were written on. A saved comment's lines never change; its words
can be edited, and it can be deleted, from a page that shows the current version.
A comment's id is never given to another, and a change or deletion says which
edit of the comment the page saw, so a second tab cannot overwrite the first
unseen.
If the Delve changes before a comment is saved, its words stay in the open page
and wait for the next line the reviewer presses, or until the reviewer discards
them. Nothing typed is lost to a refused save, an update, or an agent sorting the
diff again.

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
| `create_report(source?)` | Snapshot a source of the repository the agent was started in and return the report id, an address for the person, file counts and what was auto-ignored. Calling it again for the same source returns the same report, brought up to date. With no source it opens what the no-argument command would, or lists the choices. |
| `list_reports()` | Find reports to resume. |
| `get_manifest(report, cursor?)` | A summary, the sections in reading order, then every file with status, line counts, hunk ids, guessed role and current buckets, paged. Read first. |
| `get_diff(report, files?, only_uncategorised?, cursor?)` | The diff as labelled text (`+40`, `-38`, hunk ids), paged by size. |
| `get_file(report, path, side?, lines?)` | Lines of any file from either tree, for context, a thousand at a time; a folder's path (`.` for the root) lists what is in it. No file larger than 8 MiB is read. |

Writing:

| Tool | Purpose |
|---|---|
| `set_overview(report, version, markdown)` | What the change does, in reading order. |
| `upsert_sections(report, version, sections[], order?, remove?)` | Create, retitle, summarise and reorder sections, set each section's cross-references to lines that live elsewhere, and remove sections that hold nothing. A report has at most 50 sections. All or nothing. |
| `assign(report, version, items[])` | Put change lines in a section or in `ignored` (with a reason), and optionally set a role. An item names a file, a glob, hunk ids or line ranges. Returns what each item took, what it moved out of another place, what was rejected and how many lines remain. |
| `set_reading_order(report, version, section, steps[])` | A section's reading order (4.3.1): each step a file, or line ranges of a file, already in that section, with an optional short note. Replaces the section's order; an empty list goes back to path order. All or nothing. |
| `get_coverage(report)` | What is still uncategorised, plus warnings: empty sections, oversized sections, split change runs, tests with no section. |
| `add_notes(report, version, notes[], replace?)` | Labelled agent notes on changed line ranges, at most 50 a call and 100 a version. A note the version already holds is passed over, so a retry adds nothing and a dismissed note stays dismissed; `replace` removes the version's notes the reviewer has not dismissed or promoted. |

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

The daemon remembers, in memory only, when a server started in each folder last
sent a message and when a tool call last named each report. That is all a Delve's
page is told about agents (8.2): when one was last heard from, and where. A tool
call is never refused or slowed by it, and a restart forgets it.

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

**Versions.** Every reading answer starts with the report and its version, and
every write carries the version the agent read. A write on a version that is no
longer the newest is refused, saying the diff changed and to read the manifest
again, so an agent never sorts lines it has not seen. Paging cursors carry the
version too.

**Which repository.** `create_report` takes no folder. It opens the repository of
the folder the agent was started in, which `diff-delver mcp` names to the daemon
and the agent cannot change. An agent never makes diff delver run git anywhere
else. For another repository, the person starts the agent there, or runs
`diff-delver` there themselves. Reports already in the data folder can be read and
sorted from their stored snapshots, which runs nothing in their working folders.

**Answers.** The reader is a model that has read nothing else, so every answer
says what happened and what to do next, and every refusal says what was wrong with
the call, in terms of the call, and what to send instead. No answer is longer than
about 60,000 characters whatever the diff's size: the manifest and the diff come in
pages with a cursor that names a place in the whole diff, so sorting between pages
never skips a file, and every list stops short of the page and says how many more
there are, so the cursor and the next step are never the part cut off. Text from
the repository or from an agent that an answer repeats (paths, titles, reasons,
code) is escaped or quoted so it stays on its line and cannot pass for diff
delver's own words; characters that cannot be seen or that turn text round are
written as escapes, as on the page.

**Sent twice.** Agents retry, and the shim sends a message again when the daemon
was replaced, so every write sent twice is harmless and answers as a success.

**The browser.** When an agent first creates a report, diff delver opens it in the
person's browser, as the command does, at most one window for a session of
`diff-delver mcp` (none when it was started with `--no-open`). Every `create_report`
answer also carries an address of its own, which works once; calling
`create_report` again gives a fresh one.

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

`skills/diff-delver/SKILL.md`, in the Agent Skills format. Its one copy lives in
the Claude Code plugin (`plugins/claude-code/`), which packages it together with the
MCP configuration; `skills/diff-delver` is a link to it. It describes only the tools
that exist, and grows with them. Outline:

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

The agent's writing is part of what there is to read. The overview and each
section's summary count as unread until the reader has been to them, and the
next thing unread may be one: ticking a file whose next unread file is in a new
section goes to that section's summary first, and every other way of going to
the next unread thing (`n`, `r`, finishing a section) does the same. Moving on
from a summary marks it read. What is left to read is counted with the
summaries among it, apart from the changes, so the bar of changes reviewed
stays a count of changes. A summary the agent rewrites is unread again.

Moving around the page eases into place, a short and quiet scroll instead of a
jump, so the reader sees where they went; with reduced motion it jumps.

**Three things you can do to code.** Select lines and the same small menu always
appears: **Comment**, **Flag**, **Ask**. Selecting is a click on the `+` beside a
line, with shift-click or a drag to extend. By keyboard it is the same thing:
move to a line with the arrow keys, hold Shift with the arrow keys to extend the
selection, and press Enter to open the menu.

Comment and Flag are built; Ask comes with the live loop. A line's number is the
control: a `+` shows on it on hover and focus, and pressing it, or taking several
lines, opens the menu under them (Comment, Flag, Cancel). `c` and `f` skip the menu:
`c` goes from a file to its lines and, on a line, opens the comment box; `f` flags
the line or the lines taken at once. A saved comment is drawn under the last of its
lines, as plain text, with **Edit** and **Delete**. A flag is drawn there too,
"Flagged to look at again", with **Add words** and **Clear**: its words are
optional, flagging the same lines again makes no second flag, and Clear takes it
off in one press, since raising it again is one press too. A list above the diff
counts every comment and flag and goes to each, and `F` goes to the next flag. A
flag is stored as a comment of kind `flag`, so it carries over to a new version as
comments do. The agent's notes are drawn at their lines after the reviewer's own,
labelled "Agent note" with their kind, with **Dismiss** and **Promote to review**;
they are counted above the diff and in the overall review's bar apart from the
reviewer's comments, and `a` hides or shows them all.

**States explained in place.** Wherever something could puzzle a newcomer, the
page says what it is, once and briefly:

| Situation | What the page says |
|---|---|
| The agent is still working | "Sorting the diff: 340 of 1,200 lines placed. You can start reading." |
| Lines nobody sorted | "Not sorted yet: 3 files. The agent did not place these, so they are listed here." |
| No agent connected | "No agent connected. Copy this request and paste it into your agent." with a copy button |
| The diff changed | "This diff has changed since you opened it. Update to see 3 changed files. Lines you marked as reviewed stay marked, unless they or the lines close to them changed." (and, once comments exist, that they are kept too) |
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
  Open a section’s file list to jump straight to its part of a file.
- **Main pane**: the section summary, then its slices. Each slice has a tick, the
  file path, chips for the file's other sections, and the diff.
- **Side panel**: threads, agent notes, the request queue and the draft review.
- **History**: the report's timeline of revisions and reviews (6.4).
- **File tree view**: an alternative to the guided view that lists every file once
  with chips showing where its parts live. This is the direct answer to "is every
  file accounted for".

**Moving between Delves.** Every page's header has a link to the list of Delves.
A Delve's page has one control, **Open another**, in the rail and on `d`, that
opens a panel without leaving the page: the other Delves, most recently active
first, described as the list describes them (with the folder, when two
repositories share a name), with a box to find one by name when there are more
than a few; **Choose commits or a branch** for this Delve's repository (3.1); and
the list of all Delves. Each is a link. The list of Delves offers the
same choice for every repository a Delve was opened in, so a terminal is needed
only for a repository diff delver has not seen. When a repository's folder is no
longer there, the page says so in place of the link. A comment being written is
kept by the tab through every one of these ways out, and the Delve it belongs to
is marked wherever it is listed. A pull request, when it is a source (build step
6), is opened from the same place as commits and branches.

**Asking an agent from the page.** A Delve with anything not sorted offers,
under "Not sorted yet", **Have an agent sort this**. It opens three steps in
place, each with something to copy: the command that connects a coding agent to
this copy of diff delver once, for every folder (for Claude Code, for Codex, or
the plain command for any other agent), the folder to start the agent in, and a
sentence to ask it that names this Delve, so the agent sorts the Delve on screen
and does not make another. The command is for the copy that is running: a
release's address for a release, the file that started the daemon for a build of
the repository, with the data folder when it is not the default. Step 1 says
when an agent connected and where it was started, as something that happened,
never as "connected now", and when that agent was started in another folder,
that it is set up and should be started in this one. When the agent's first
sections arrive, the steps give way to them and the page says an agent has
started sorting. The README says the same for a person who has not opened a page
yet.

### 8.3 Reading the diff

- Unified or split, syntax highlighted, optional whitespace hiding.
- The file path and Reviewed checkbox stay below search while its changes scroll.
  Marking a file or section as reviewed briefly folds away its visible changes,
  with an immediate close when reduced motion is enabled.
- **Bookmark this spot** saves one place per Delve in the current browser tab and
  keeps it across reloads. On narrow screens the controls stay at the bottom of
  the screen while you read. **Return to bookmark** names the file and goes back
  to the saved line, even if the agent moved it to another section in the same
  version. For a line in expanded context, it opens a small window around it.
  If the line is unavailable or the version changed, it explains why it is
  showing the start of the file. If a filter hides the destination, it asks
  you to show everything before returning.
- Expand context above or below a hunk, or expand to the whole file.
- **Open file** (`t`) finds files by name or path in the Delve’s snapshot, with
  changed files first. Read a file before or after the changes, jump from a
  marked line to its change in the diff, or use Back to resume reading.
- Search the tree (`git grep` against the snapshot). Jump from an identifier to its
  other occurrences. Proper symbol navigation is out of v1.
- Non-diff lines can be selected, commented on and flagged like any other.
- Drag in the gutter to select a range, then comment, flag or raise a request.
- Keyboard: next and previous slice, tick, comment, flag, expand, toggle tests,
  and selecting a range of lines (arrow keys to move, Shift with them to extend,
  Enter for the menu). Every line of a diff, on either side, can be reached and
  selected without a pointer.
- The tick key works through the diff: it marks the file the reader is on as
  reviewed and goes on to the next one waiting, so pressing it again and again
  reviews the diff in reading order. It never takes a mark off (the file's tick
  box does that); on a file already reviewed, or ignored, it says so and only
  moves on. A tick that is refused leaves the reader on the file, where the
  refusal is shown, and a key held down marks one file, not one for each repeat.

### 8.4 Visual diffs

- **Image files** (PNG, JPEG, GIF, WebP, SVG): side by side, swipe, onion skin and
  pixel difference, with dimensions and file size. SVG also has its text diff.
- **Snapshot-test images**: recognised by path convention (Playwright
  `*-snapshots/`, `__image_snapshots__/`, Paparazzi, and project patterns), given
  `role: snapshot`, and shown next to the test that owns them. They follow the
  tests toggle.

An image is one file-level unit, assigned and ticked like any slice.

**What is built.** Image files, without snapshot-test pairing. The modes are
**Side by side**, **Slider** (the swipe: the two images stacked, with a slider
that shows more of either), **Onion skin** and **Pixel difference**, which shows
the pixels that changed in magenta over a copy of the image after faded toward
white, with how many changed. Buttons above the image choose one and `i` steps
through them; one mode holds for every image on the page. Each side says its
format, its size in pixels and its size in bytes; when the sizes differ the page
says so and lines the two up at their top left. A file counts as an image only
when its name and its bytes agree (an SVG's `<svg` within its first 64 KiB); a
side that is not one is described as what it is, with its size, and an image is
read from the snapshot store, never the repository, and served so that an SVG
can run nothing. Images over 16 MiB are not shown, and pixel difference compares
at most 4,096 by 4,096 pixels and only the first frame of an animation; the page
says so in each case. The chosen mode is not remembered yet (1.1, point 9).

### 8.5 Words the reviewer sees

This document uses precise internal terms. The interface does not. This table is
the starting vocabulary, to be adjusted by watching people use it.

| Internal term | On screen |
|---|---|
| report | A Delve is a saved review, named by its source: "Pull request #123", "Uncommitted changes", "feature-x compared with main" |
| a run of commits | Named by how many commits it is and their subjects: "3 commits: “Add a discount rate” to “Say which code was used”", "2 commits: “A” and “B”", "The first 5 commits: …" from a repository's first commit. Never by commit ids |
| the main branch, a remote-tracking branch | "Main branch" on the one branch that counts and comparisons name; "On origin" on a branch that is the remote's, not a local one |
| revision | "Version 2", with when it arrived and what changed |
| snapshot | Not shown. Its size appears on the update |
| slice | Not named. A split file shows "part 2 of 3" |
| step of a reading order (4.3.1) | "Step 2 of 3" on its part, "After the steps" on the lines no step names; in the Tests group, "Step 2 of *Session expiry*". Its note is headed "From the agent, on this step", apart from agent notes |
| change line, file-level unit | "a change": one added line, one removed line, or one change to a file itself such as a rename. The page says so once, and every count is in changes |
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
- **GitHub**: a pull request review under the reviewer's own identity, published
  when the review is finished, as a comment, an approval or a request for changes;
  a tick box posts it as a draft instead, a pending review only the reviewer sees
  until they submit it on GitHub. Comments on lines GitHub cannot anchor (non-diff lines) go
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

**What is built.** Finish and copy, the preview and the list of finished
reviews, with comments and flags, and `get_review`. Flags are listed under
"Flagged for another look" with their words quoted, and no code; on a pull
request they go in the review's text, never on lines. The panel sits under the draft
comments on a Delve's page and finishing needs the same review access as
writing a comment. The text differs from the example above in these ways, on
purpose:

- The heading names the Delve as its title does, and the text then names the
  report, its version and, when its new side is a commit, that commit.
- The reviewer's words are a block quote under the quoted code, so nothing typed
  in a comment can open a heading or a code block of the review's own.
- At most the first 40 lines of a comment's lines are quoted, and the text says
  when it stops short.
- `get_review` gives the text between a line that marks its start and one that
  marks its end, and a review too long for one answer in parts (`part`).

A finish is refused, saying why, when the Delve's version or the draft changed
since the page showed it, including when another tab finished the same comments,
and a comment finished in another tab and then edited says which review it is
in. A closed Delve must be reopened to finish.

**Posting to a pull request, as built.** On a pull request's Delve, finishing
posts the review to the pull request as one GitHub review, as a comment, an
approval or a request for changes, comment chosen to start with, or, with the
tick box, as a draft only the reviewer sees until they submit it on GitHub. The
overall review is its text and each comment goes on its lines; a comment GitHub
cannot place there, on lines outside its diff, on an earlier version or on a
binary file, goes into the text with its file, lines and code, and if GitHub
still refuses the lines the review is posted once more with every comment in the
text, and the page says so. Before posting, "Show what will be posted" shows the review's
text and which comments go on their lines, and the page says how many will go in
the text. Nothing is finished unless the post was taken: a refusal keeps the
draft and says why and what to do. A post is never made twice: one that may
have reached GitHub without its answer is looked for there, by a mark with a
secret part and by the signed-in account as its author, before anything else is
finished; for a minute after it was sent nothing is, since GitHub may still be
making it; and a review GitHub took is recorded as it was sent, while anything
written since stays in the draft. When GitHub cannot be asked about such a post,
the reviewer may still finish and copy, knowing it may be on GitHub. GitHub
offers no way to make a post safe to send twice, so this is the guard. Each
finished review shows where it was posted, with a link to it; that, and only
that, is kept of the delivery log (6.3) so far. A finished review cannot be
posted again from the list yet. "Finish and copy only" posts nothing.

**The overall review.** The reviewer writes the review's summary (6.3) in a bar
pinned to the foot of a Delve's page, so it is at hand wherever they are in the
diff. Put away, the bar shows the first words written, or that nothing is written
yet, whether something typed is not saved, how many comments the draft holds and
the way to finish; opened, it is a box that saves as a comment's does, and `v`
opens it. It starts put away, and stays open once opened, for every Delve, until it
is put away again. It is part of the draft: it needs review access, a review can be
finished with it and no comments, finishing empties it, and a finish is refused
when it changed since the page showed it, as for comments. It belongs to the whole
Delve, not to a version, so it can be saved on any version while the Delve is open.
In the text handed over it comes first, under its own heading, quoted as comments'
words are. The verdict (6.3) is not built yet.

## 9. Storage and safety

- SQLite in the data directory, beside the stores, so there is one place to find, back up or delete. Reports, revisions, sections, assignments
  (as ranges), reviewed ranges, threads, messages, reviews with their frozen items
  and export text, and an append-only event log that feeds live updates.
- One git object store per reviewed repository in the data directory (3.2).
- Review state is personal and never written into the repository.
- The daemon of the machine's default data folder is always at
  `http://127.0.0.1:12321`, so links and pages left open still reach it after a
  restart, or after a newer diff delver replaces it; a page served by an earlier
  version says so and offers to reload, and one let in by an agent's link, which
  is good for one daemon only, offers to reload to be told how to get back in.
  A daemon of any other data folder takes a free port, and when 12321 is taken
  the daemon takes another for that run and says which.
- The daemon binds to `127.0.0.1`, checks `Host` and `Origin`, and requires a
  bearer token or browser session cookie. No token appears on a command line or in
  an address. A browser is let in by a single-use code, which the daemon exchanges
  for a session cookie. A code does not run out with time: it is kept, in memory
  only, until it is used or the daemon stops, and only the newest unused ones are kept. diff
  delver is served behind a separate layer of authentication, and its addresses
  reach nothing that could misuse them, so a link that had expired by the time the
  person clicked it cost more than it protected. There are two grants, each with its
  own Strict cookie. A link written into an agent's answer lets a browser read and
  tick. Reading and writing drafts, and deleting a Delve, need review access, which
  only a window diff delver opens in the person's own browser has: the one the
  command opens, the one opened for an agent's new report, and the one a page asks
  for with **Turn on comments in this browser**. Whoever asks for such a window
  names a page of the daemon and learns only whether a browser could be asked; the
  code goes to the system's browser opener and nowhere else. So an agent can make a
  window appear in front of the person, at most one every few seconds, and cannot
  receive the grant. A cross-site
  entry commits a local page before continuing to the Delve, so the browser can
  send those cookies. Pages load only the daemon's own resources and scripts.
- The review cookie's token belongs to the data folder and is kept there, readable
  only by the person, so a browser keeps review access when the daemon restarts.
  Every other token and code is one daemon's and ends with it. Stopping diff
  delver, deleting that file and starting it again takes review access from every
  browser. Accepted: a
  review cookie that reached another server on the machine stays good until then,
  not only until the daemon stops; and anything that can drive the person's own
  browser can press the button, as it could already do anything else there.
- Browsers send a cookie to every port of a host, so another server on the same
  machine that the person visits would receive this cookie. That is accepted for a
  tool one person runs on their own machine.
- Agent Markdown is sanitised. Raw HTML is not rendered.
- Diff content is untrusted input to the agent. The skill says to treat it as data.
- Human-only state (reviewed marks, comments, flags, the review) has no MCP write
  path. An agent cannot close or delete a report either.
- `/mcp` requires its own bearer token. That token grants access only to MCP.
  The command's separate bearer token can issue a link that grants draft access.
- The daemon runs git in the repository being opened with that repository's own
  settings, as the person's own git does there, so opening it can run commands those
  settings name, such as a clean filter. For the command, that is the folder the
  person ran it in. For an agent, it is only the folder the agent was started in,
  never one the agent names. An agent that can write that repository's git settings
  can therefore have commands run when a report is opened. That is accepted for now:
  such an agent can already have them run by the person's own git.
- An agent reads files only from the snapshot, never from the working folder, and
  never one larger than 8 MiB.
- For a local repository the daemon makes one kind of network call, and only when
  the person presses the button for it: asking the repository's remotes which
  commits their branches are at (3.1). It runs the person's git with that
  repository's settings, as `git fetch` there would, so it can run what those
  settings name for reaching a remote: an ssh command, a credential helper, a
  remote's own upload command or transport. That is the same exposure as the
  bullet above, reached by a button on the page and never by an agent or by
  loading a page. It never asks for a password or passphrase, stops after a time
  limit with everything it started, and never shows or logs a password that a
  remote's address holds.

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
  report triggers. Objects written within the last hour are kept through a
  collection, so deleting a fresh report frees its space up to an hour later. The
  confirmation says "frees about 40 MB", and says "within an hour" when that applies.

## 10. User journeys

Each journey is a named scenario, written from the reviewer's side. The developer
guidance says [how journeys are tested](DEVELOPING.md#testing).

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
| J11 | Review a GitHub PR | open a repository's open PRs, open one, see a push as its next version, and post the finished review to it, published or as a draft |
| J12 | Review a jj change | open a change, amend it, and continue in the same report |
| J13 | Visual changes | compare a changed image in each mode and see a snapshot image beside its test |
| J14 | Agent notes | hide all notes, dismiss one, promote one into the review |
| J15 | Disk space | see what each report and snapshot takes, delete a report and see the space freed |
| J16 | Reading and finding | read code coloured by language or plain, in one column or side by side, with white-space changes hidden, search the whole diff, move from match to match, and open changed and unchanged files by name |
| J17 | Choose commits to review | open the choose page for a repository, see its branches and commits with their times and sizes, pick a run of commits or a whole branch with the keyboard, open it, and see when the repository last fetched and whether origin has moved on |
| J18 | Draft comments | open a Delve from an agent's link and turn comments on in one press, comment on a line or a run of lines from the line itself, see each comment at its lines and in a list that goes to it, edit and delete one, and keep what was typed through a refused save and an update |
| J19 | Move between Delves | go from a Delve to another through the panel that lists the others, open the choose page for the Delve's repository from the panel and open a branch there, and reach the list from the header, where each repository offers the same way to open something new, with no terminal |
| J20 | Have an agent sort this Delve | on a Delve no agent has sorted, open the steps under "Not sorted yet", copy the command for an agent, the folder and the sentence that names this Delve, see the page say an agent connected, and see the steps give way to the agent's sections |
| J21 | The overall review | write an overall review in the bar pinned to the bottom of a Delve, put it away and see its first words and how many comments there are, change it, and find it at the top of the finished review |
| J22 | Read a section in the agent's order | open a section the agent ordered, read its steps in order with the agent's note on each, a file split over two steps among them, tick each step and move on with `r`, and see lines no step names come last |

The agent interface is also tried with real coding agents. Recorded sessions of
Claude Code and Codex sorting fixture diffs through the MCP server are kept in the
repository; the tests replay them, and what a replay leaves on the page is checked
like a journey, with committed screenshots. The developer guidance says
[how trials are run](DEVELOPING.md#agent-trials).

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

The order is a plan, not a rule: the project owner moves work ahead when it is
wanted sooner. Finishing a review with comments (step 3) and the image viewer
(step 7) were built before the rest of steps 3 to 6.

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
