/**
 * What git status says about the working tree, read without touching the
 * repository: `GIT_OPTIONAL_LOCKS=0` (set for every run) stops it refreshing the
 * index, fsmonitor is off, and a split index is read through a private copy.
 */
import { join } from 'node:path';
import { ok, type Result } from '#lib/core/result.ts';
import type { GitSourceError } from './git-source-error.ts';
import { gitIn, sharedIndexFiles, type LocalRepository } from './local-repository.ts';
import { withScratchIndex } from './scratch-index.ts';

export interface StatusEntry {
	/** The path from the top of the working tree, as bytes. */
	readonly path: Buffer;
	readonly kind: 'changed' | 'renamed' | 'unmerged' | 'untracked';
	/** A submodule whose checked-out commit differs from the index: its HEAD is what a snapshot records. */
	readonly submoduleMoved: boolean;
}

export interface WorkingTreeStatus {
	/** git's whole answer, for fingerprinting. */
	readonly raw: Buffer;
	readonly entries: readonly StatusEntry[];
}

/** How many space-separated fields come before the path in each kind of record. */
const FIELDS_BEFORE_PATH: Readonly<Record<string, number>> = { '1': 8, '2': 9, u: 10, '?': 1 };

function parseStatus(raw: Buffer): readonly StatusEntry[] {
	const records: Buffer[] = [];
	for (let at = 0; at < raw.length;) {
		const end = raw.indexOf(0, at);
		records.push(raw.subarray(at, end === -1 ? raw.length : end));
		at = end === -1 ? raw.length : end + 1;
	}
	const entries: StatusEntry[] = [];
	for (let i = 0; i < records.length; i += 1) {
		const record = records[i] ?? Buffer.alloc(0);
		const type = String.fromCharCode(record[0] ?? 0);
		const fields = Object.hasOwn(FIELDS_BEFORE_PATH, type) ? (FIELDS_BEFORE_PATH[type] ?? 0) : 0;
		if (fields === 0) continue;
		let at = 0;
		for (let n = 0; n < fields; n += 1) at = record.indexOf(0x20, at) + 1;
		const path = record.subarray(at);
		const sub = type === '?' ? 'N...' : record.subarray(5, 9).toString('latin1');
		entries.push({
			path,
			kind:
				type === '1'
					? 'changed'
					: type === '2'
						? 'renamed'
						: type === 'u'
							? 'unmerged'
							: 'untracked',
			submoduleMoved: sub.startsWith('SC')
		});
		// A rename's record is followed by its old path.
		if (type === '2') i += 1;
	}
	return entries;
}

/** The working tree's changes against HEAD, staged or not, with untracked files one by one. */
export async function workingTreeStatus(
	repo: LocalRepository
): Promise<Result<WorkingTreeStatus, GitSourceError>> {
	const workTree = repo.workTree;
	if (workTree === undefined) {
		return {
			ok: false,
			error: { kind: 'NoWorkingTree', repository: repo.commonDir, source: 'working-tree' }
		};
	}
	const run = (index: string | undefined) =>
		gitIn(
			repo,
			workTree,
			[
				'-c',
				'core.fsmonitor=false',
				'status',
				'--porcelain=v2',
				'-z',
				'--untracked-files=all',
				'--ignore-submodules=dirty',
				'--renames'
			],
			{ env: index === undefined ? {} : { GIT_INDEX_FILE: index } }
		);
	const status =
		(await sharedIndexFiles(repo)).length === 0
			? await run(undefined)
			: await withScratchIndex(repo, undefined, (scratch) => run(scratch.index));
	if (!status.ok) return status;
	return ok({ raw: status.value.stdout, entries: parseStatus(status.value.stdout) });
}

/** Where an entry is on disk. */
export function entryOnDisk(repo: LocalRepository, entry: StatusEntry): Buffer {
	return Buffer.concat([Buffer.from(join(repo.workTree ?? repo.gitDir, '/')), entry.path]);
}
