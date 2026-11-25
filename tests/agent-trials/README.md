# Agent trials: results

Real coding agents sorting fixture diffs through diff delver's MCP server,
recorded. Every refusal an agent ran into, every wrong turn and every needless
call is a finding about our tools and the skill, not about the agent. How to run
a trial, how replay works and what is safe to commit are in the developer guidance, under
[Agent trials](../../docs/DEVELOPING.md#agent-trials).

Each trial gives the agent the same prompt:

> Use diff delver to get my uncommitted changes ready for me to review.

| Fixture | What it is |
|---|---|
| `shop` | 7 files, 22 change lines: a file split across two concerns, a test, a re-recorded fixture, a script made executable, a pure rename, a lockfile (`tests/support/scripted-categorisation.ts`). |
| `ledger` | A small invoicing service, 31 files, 1,026 change lines: currencies and structured logging interleaved in four files, tests beside their code and one that covers nothing in particular, a lockfile, a generated file marked `linguist-generated`, a re-recorded snapshot, a rename with edits, a script made executable, an image (`tests/support/ledger.ts`). |

## The runs

Recorded on 2026-11-21 with Claude Code 2.1.328 (model `claude-opus-5-5`) and
Codex CLI 0.170.0 (model `gpt-6.2-sol`). Eight real runs of the fourteen budgeted.
Runs 1 to 6 had the skill as first written; run 7 had it after its sorting advice
was corrected (below). Tokens are as each CLI reports them: Claude Code counts
cached input apart (cache read / written), Codex counts it inside input.

| # | Agent | Fixture | Skill | Outcome | Calls | Refused | Sections | Time | Tokens |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Claude Code | shop | yes | full coverage | 7 | 0 | 3 | 28 s | 2,246 out; 113,891 cache read, 22,183 written |
| 2 | Codex | shop | yes | full coverage | 7 | 0 | 5 | 42 s | 172,654 in, 1,067 out |
| 3 | Claude Code | ledger | yes | full coverage | 13 | 0 | 8 | 92 s | 8,555 out; 485,181 cache read, 53,543 written |
| 4 | Codex | ledger | yes | full coverage | 12 | 0 | 8 | 67 s | 373,217 in, 2,367 out |
| 5 | Claude Code | shop | no | full coverage | 7 | 0 | 4 | 29 s | 2,510 out; 74,558 cache read, 17,914 written |
| 6 | Codex | shop | no | full coverage | 9 | 0 | 5 | 37 s | 162,685 in, 1,037 out |
| 7 | Codex | ledger | yes (corrected) | full coverage | 13 | 0 | 7 | 60 s | 402,831 in, 2,043 out |
| 8 | Codex | ledger | no | full coverage | 13 | 0 | 8 | 71 s | 357,019 in, 2,145 out |

Committed recordings: `shop.claude` (1), `shop.codex` (2), `ledger.claude` (3),
`ledger.codex` (7, which replaced 4), `shop.claude.no-skill` (5),
`shop.codex.no-skill` (6), `ledger.codex.no-skill` (8). No run reached a time or
turn limit, none wrote to the repository, and no recording shows code pasted
into prose.

Isolation was checked in every run from what the CLI reported. Claude Code
loaded our MCP server only, our plugin's skill, and its own built-in skills and
plugins (`@builtin`); none of the person's. Codex showed its own bundled system
skills and ours, our MCP server only, and no AGENTS.md.

## What the agent may do

What the harness gives each CLI is in `agent-cli.ts`, and `agent-cli.test.ts` holds
it to the exact arguments and settings below. The tests check what is passed, not
what a session then does; that was checked by hand where it could be without
starting one, as said.

**Claude Code** has the tools Read, Grep and Glob (and Skill with the skill), and
our MCP server's: no shell, so it runs no command at all. It runs in `dontAsk` mode
with nobody to ask (`--permission-prompts none`), so anything no rule allows is
refused. The rules allow `Read(//<copy>/**)`, the trial's copy of the repository,
and deny `Read(//<the trial's home>/**)`, which holds the link to the login, and
`Read(//<the login's own folder>/**)`, besides Bash, Edit, Write, NotebookEdit,
WebFetch and WebSearch. Claude Code applies Read rules to Grep and Glob as well.
What the rules do not cover: Claude Code itself, not the agent, reads its own
configuration in the trial's home, and the plugin the harness gives it.

**Codex** runs its commands in its sandbox with a permission profile of the
trial's own (`default_permissions = "trial"`): the copy of the repository, the
folder Codex is installed in (its sandbox runs Codex again), the skills in Codex's
home (the agent reads ours with `cat`) and the system's own folders (Codex's
`:minimal`: `/etc`, `/usr` and the like) may be read, and nothing may be written; `approval_policy = "never"` refuses a command that needs more
rather than asking. Its image tool, which reads a file outside the sandbox, is off.
What the profile does not cover: the system's folders are readable, so a command
can read `/etc/passwd`; MCP servers run outside the sandbox (ours is the only
one); and Codex itself reads its home, with the link to the login. Checked by hand
with Codex 0.170.0 and `codex sandbox -P trial`, which runs one command under the
profile and starts no session: a file in the copy and the skill could be read; a
file beside the copy and the login in Codex's home could not; writing in the copy
and in the skills failed.

The recordings committed so far were made before these rules: Claude Code could
then run `git status`, `git diff`, `git log` and `git show` and `ls`, and read any
file; Codex's sandbox was its plain read-only one, which reads the whole disk.

## What the agents did

**Well.** Every run reached full coverage with no refused call: the tools,
their descriptions and their answers carried both agents through on the first
try, with and without the skill. Both read the whole diff before sorting,
planned sections as a reading order (the money model first, then what builds on
it, then storage, the API, logging, housekeeping), put each test with the code
it tests, split the four mixed files by line ranges with the labels `get_diff`
gave, and acted on `get_coverage`'s warnings about runs split between sections.
Their summaries are true: both found the real import cycle between
`src/log.ts` and `src/config.ts` in the ledger, and Claude Code the rounding of
negative halves in `roundForTax`. Claude Code judged the generated API types
hand-edited (the OpenAPI file does not define what they now hold) and moved
them out of Ignored into the API section, saying why.

**Badly, or needlessly.**

1. The address expired before the person read it (bead `dd-1qq.9`). When these
   trials were recorded it opened the report once within two minutes, and
   sorting takes 30 to 90 seconds. Codex called `create_report` a second time at
   the end of four of its five runs only to get a fresh address; Claude Code
   told the person to ask for a new one if it had expired. The project owner
   decided that addresses no longer expire: each still opens the report once.
2. The skill's sorting advice was unclear: "a whole file takes only what is not
   sorted yet, so do those first". Claude Code named the lines of a mixed file
   that belong elsewhere, then the whole file for the rest, and the skill was
   changed to say that; Codex (run 7) then sorted the same way. That order
   contradicted the server's instructions and `assign`'s description (whole
   files first, then line ranges), so the skill now gives the server's order:
   both work, since a whole file takes only what is not sorted yet and lines
   move exactly what they name. No run has had the skill as it is now.
3. Codex read the same page of the diff twice with the same cursor (run 7; bead
   `dd-1qq.13`).
4. Without the skill, both agents did about as well on both fixtures: the
   skill's value did not show in these runs. Its rules that the tools cannot
   enforce (what not to write, the reading order, the final message) were
   followed by agents with and without it alike.
5. Small departures from the skill: Claude Code put the smoke test that covers
   nothing in particular in housekeeping rather than in a section of its own;
   Codex made five sections of the seven-file shop, two of them one file each.
   Neither is wrong enough to change anything.
6. `assign` numbers its items from 0 in its answer ("Item 0: took…"). No agent
   stumbled on it (bead `dd-1qq.10`).

## Found about the page

Replaying what the agents produced in journeys found four problems with the
page itself, none of which a scripted categorisation had shown:

- Following a group's link in the Groups list focused the heading, which only
  scrolled it to the bottom of the screen; on the ledger, the parts above it
  then filled in their lines and pushed it off. Fixed: the heading is scrolled
  to the top, then focused.
- After that, on a page as long as the ledger's, the heading still lands a
  fraction of a pixel differently from run to run, because a part's height is
  fractional and depends on whether its lines have come (bead `dd-1qq.11`). So
  the ledger's journeys are not committed yet; the shop's is.
- Agents write characters the bundled fonts lack: Claude Code's ignore reason in
  the shop has "→", its ledger summaries "→" and "∞" (bead `dd-1qq.8`). The
  journey step refuses a screen drawn in a system font, so the shop sorted by
  Claude Code has no journey yet.
- A step once caught a part's lines arriving far below the screen, after it had
  found nothing busy (bead `dd-1qq.12`).

## Changed because of the trials

- The skill: an address opens the report once (at first, within two minutes; it
  no longer expires), and calling `create_report` again gives a fresh one; whole
  files first, then the lines of a mixed file that belong elsewhere, as the server says (first changed to the
  opposite order, then back, see 2 above); and a `file` change also sits beside a
  file's lines when its name, mode or kind changed.
- The page: a group's heading goes to the top of the screen.

## Still open

In order of how much they matter: the fonts (`dd-1qq.8`), the variation on long
pages (`dd-1qq.11`, `dd-1qq.12`),
the repeated read (`dd-1qq.13`), the item numbering (`dd-1qq.10`). Not yet
tried: Claude Code on the ledger with the corrected skill, and without the
skill; a diff larger than the ledger; a source other than uncommitted changes;
an update mid-sort. The page does not yet show the overview, summaries or
cross-references, so how they read to a person is still to judge.
