/**
 * What an agent trial, its replay and its journey share: the fixture
 * repositories a trial can sort, the daemon a trial's agent reaches (in the
 * harness's own process, with the journeys' fixed clock and sequential ids, so
 * every answer is the same on every run and a recording replays exactly), and
 * the final state of a data folder, written out so two runs can be compared.
 *
 * The daemon reports the version of the build (`bin/diff-delver.js`), so a
 * shim started by the agent finds it through the data folder's lockfile and
 * uses it instead of starting one of its own.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { Bucket } from '#lib/core/diff/bucket.ts';
import { assignmentRowsOf, unitRowsOf, type StoredUnits } from '#lib/core/storage/stored-units.ts';
import { settableClock } from '#lib/core/clock.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { EMPTY_UNIT_SET } from '#lib/core/diff/unit-set.ts';
import { formatLineRange } from '#lib/core/line-range.ts';
import { shownRepoPath } from '#lib/core/shown-path.tiny.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { loadAppHandler, type AppHandler } from '#lib/server/daemon/app-handler.ts';
import {
	describeDaemonStartError,
	startDaemon,
	type RunningDaemon
} from '#lib/server/daemon/daemon.ts';
import { describeReportError, ReportService } from '#lib/server/reports/index.ts';
import type { RepositoryOptions } from '#lib/server/sources/git/index.ts';
import { BUILT_COMMAND } from '../support/build.ts';
import type { GitRepo } from '../support/git-repo.ts';
import { buildLedger } from '../support/ledger.ts';
import { buildShop } from '../support/scripted-categorisation.ts';
import { versionOfLine } from '../../src/lib/core/cli/version-line.ts';

/** The repositories a trial can sort, each built by real git into a folder of its name. */
export const TRIAL_FIXTURES = {
	/** Seven files and 22 change lines: one of each thing a real diff has (scripted-categorisation.ts). */
	shop: { build: buildShop },
	/** 31 files and about a thousand change lines, three concerns interleaved (ledger.ts). */
	ledger: { build: buildLedger }
} as const satisfies Record<string, { readonly build: (repo: GitRepo) => Promise<void> }>;

export type TrialFixtureName = keyof typeof TRIAL_FIXTURES;

const FIXTURE_NAMES: readonly TrialFixtureName[] = ['shop', 'ledger'];

/** The fixture of this name, or undefined if there is none. */
export function trialFixture(name: string): TrialFixtureName | undefined {
	return FIXTURE_NAMES.find((n) => n === name);
}

/** What the person types to the agent, the same in every trial. */
export const TRIAL_PROMPT = 'Use diff delver to get my uncommitted changes ready for me to review.';

/** The time on a trial daemon's clock: the journeys', so a replay in a journey is the same. */
export const TRIAL_TIME = Date.UTC(2026, 0, 15, 9, 30);

/** The version the build reports, which the shim compares with the daemon's. */
export async function builtVersion(): Promise<CodeVersion> {
	const printed = await new Promise<string>((resolve, reject) => {
		execFile(process.execPath, [BUILT_COMMAND, '--version'], (error, stdout) => {
			if (error === null) resolve(stdout);
			else reject(new Error(`The build would not say its version: ${error.message}`));
		});
	});
	const version = versionOfLine(printed);
	if (version === undefined) throw new Error(`The build printed no version: ${printed}`);
	return version;
}

let app: Promise<AppHandler> | undefined;

/** A daemon for a trial or a replay: fixed clock, sequential ids, the build's version. */
export async function startTrialDaemon(
	dataDirectory: AbsolutePath,
	repository: RepositoryOptions,
	version?: CodeVersion
): Promise<RunningDaemon> {
	app ??= loadAppHandler();
	const time = parseTimestamp(TRIAL_TIME);
	if (!time.ok) throw new Error('The trial time does not parse.');
	const started = await startDaemon({
		dataDirectory,
		clock: settableClock(time.value),
		ids: sequentialIds(),
		version: version ?? (await builtVersion()),
		app: await app,
		repository
	});
	if (!started.ok) throw new Error(describeDaemonStartError(started.error));
	await started.value.cleaned;
	return started.value;
}

/** One report as sorted: its sections in reading order, and where every change unit is. */
export interface SortedReport {
	readonly id: string;
	readonly source: string;
	readonly version: number;
	readonly overview: string | null;
	readonly sections: readonly {
		readonly id: string;
		readonly title: string;
		readonly summary: string | null;
		readonly references: readonly string[];
	}[];
	/** One line per run of units sharing a place and role: `src/a.ts +3..+9 section:auth code`. */
	readonly placements: readonly string[];
}

function unitsText(units: StoredUnits): string {
	switch (units.kind) {
		case 'file':
			return 'file';
		case 'lines':
			return formatLineRange(units.range);
	}
}

function bucketText(bucket: Bucket): string {
	switch (bucket.kind) {
		case 'section':
			return `section:${bucket.section}`;
		case 'uncategorised':
			return 'not-sorted';
		case 'ignored':
			switch (bucket.by.kind) {
				case 'rule':
					return `ignored:rule:${bucket.by.rule}`;
				case 'pattern':
					return `ignored:pattern:${bucket.by.pattern}`;
				case 'agent':
					return `ignored:agent:${JSON.stringify(bucket.by.reason)}`;
			}
	}
}

/**
 * Every report in a data folder as sorted, read with a service of its own, so
 * call it once the daemon serving the folder has stopped.
 */
export async function sortedReports(
	dataDirectory: AbsolutePath,
	repository: RepositoryOptions
): Promise<readonly SortedReport[]> {
	const time = parseTimestamp(TRIAL_TIME);
	if (!time.ok) throw new Error('The trial time does not parse.');
	const opened = await ReportService.open({
		dataDirectory,
		clock: settableClock(time.value),
		ids: sequentialIds(),
		repository
	});
	if (!opened.ok) throw new Error(describeReportError(opened.error));
	const service = opened.value;
	try {
		const listed = service.list();
		if (!listed.ok) throw new Error(describeReportError(listed.error));
		const out: SortedReport[] = [];
		for (const entry of listed.value) {
			if (entry.kind !== 'report') throw new Error(`A damaged report: ${entry.id}`);
			const loaded = await service.load(entry.id);
			if (!loaded.ok) throw new Error(describeReportError(loaded.error));
			const { diff, state, sections, references, overview, revision, summary } = loaded.value;
			out.push({
				id: entry.id,
				source: summary.title,
				version: revision.number,
				overview: overview ?? null,
				sections: sections.map((s) => ({
					id: s.id,
					title: s.title,
					summary: s.summary ?? null,
					references: unitRowsOf(references.get(s.id) ?? EMPTY_UNIT_SET).map(
						(row) => `${shownRepoPath(row.path)} ${unitsText(row.units)}`
					)
				})),
				placements: assignmentRowsOf(diff, state).map(
					(row) =>
						`${shownRepoPath(row.path)} ${unitsText(row.units)} ${bucketText(row.assignment.bucket)} ${row.assignment.role}`
				)
			});
		}
		return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	} finally {
		service.close();
	}
}

/** Where a trial keeps its recordings, relative to the repository. */
export const RECORDINGS_DIRECTORY = join(import.meta.dirname, 'recordings');

const ROOT = join(import.meta.dirname, '..', '..');
/** The skill an agent is given (DESIGN 7.3). */
export const SKILL_FILE = join(ROOT, 'plugins', 'claude-code', 'skills', 'diff-delver', 'SKILL.md');
/** What an agent sees of the MCP server (`pnpm mcp:surface`). */
export const SURFACE_FILE = join(
	ROOT,
	'src',
	'lib',
	'server',
	'mcp',
	'fixtures',
	'agent-surface.json'
);

function sha256(path: string): string {
	return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/** The hashes a recording made now would hold, to tell an older recording from a current one. */
export function currentHashes(): { readonly agentSurface: string; readonly skill: string } {
	return { agentSurface: sha256(SURFACE_FILE), skill: sha256(SKILL_FILE) };
}
