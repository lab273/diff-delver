/**
 * A diff ready for assignment: every file of one snapshot pair with its change
 * units worked out (DESIGN 4.1).
 *
 * The units of a file are its added lines, addressed by new-side line number,
 * and its deleted lines, addressed by old-side line number. A file whose change
 * has no lines at all has exactly one file-level unit instead.
 */
import type { HunkId } from '../hunk-id.tiny.ts';
import { RangeSet } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import type { Side } from '../side.tiny.ts';
import { hunksOf, type FileDiff, type Hunk } from './file-diff.ts';

/** Line numbers on each side. */
export interface SideLines {
	readonly old: RangeSet;
	readonly new: RangeSet;
}

/**
 * A run of adjacent changed lines in a hunk, between context lines: the deleted
 * lines and the added lines that replace them. Splitting one between buckets is
 * allowed but warned about (DESIGN 4.3).
 */
export interface ChangeRun extends SideLines {
	readonly hunk: HunkId;
}

export interface DiffFile {
	readonly file: FileDiff;
	/** The changed lines, empty on both sides for a file-level unit. */
	readonly changed: SideLines;
	/** False when the file has a single file-level unit instead of lines. */
	readonly hasLines: boolean;
	readonly unitCount: number;
	readonly hunks: ReadonlyMap<HunkId, Hunk>;
	/** The changed lines of each hunk. */
	readonly hunkLines: ReadonlyMap<HunkId, SideLines>;
	readonly runs: readonly ChangeRun[];
}

export interface Diff {
	/** In git's order, which sorts by path. */
	readonly files: readonly DiffFile[];
	readonly byPath: ReadonlyMap<RepoPath, DiffFile>;
	readonly unitCount: number;
}

/** Two files claim the same path. git never gives this; it means the input was built wrongly. */
export interface DuplicateFilePath {
	readonly kind: 'DuplicateFilePath';
	readonly path: RepoPath;
}

/** Indexes the files of one diff, working out each file's change units. */
export function makeDiff(files: readonly FileDiff[]): Result<Diff, DuplicateFilePath> {
	const indexed: DiffFile[] = [];
	const byPath = new Map<RepoPath, DiffFile>();
	let unitCount = 0;
	for (const file of files) {
		if (byPath.has(file.path)) return err({ kind: 'DuplicateFilePath', path: file.path });
		const entry = indexFile(file);
		indexed.push(entry);
		byPath.set(file.path, entry);
		unitCount += entry.unitCount;
	}
	return ok({ files: indexed, byPath, unitCount });
}

function indexFile(file: FileDiff): DiffFile {
	const hunks = new Map<HunkId, Hunk>();
	const hunkLines = new Map<HunkId, SideLines>();
	const runs: ChangeRun[] = [];
	const allOld: number[] = [];
	const allNew: number[] = [];
	for (const hunk of hunksOf(file)) {
		hunks.set(hunk.id, hunk);
		const hunkOld: number[] = [];
		const hunkNew: number[] = [];
		let runOld: number[] = [];
		let runNew: number[] = [];
		const endRun = (): void => {
			if (runOld.length > 0 || runNew.length > 0) {
				runs.push({
					hunk: hunk.id,
					old: RangeSet.fromNumbers(runOld),
					new: RangeSet.fromNumbers(runNew)
				});
			}
			runOld = [];
			runNew = [];
		};
		for (const line of hunk.lines) {
			switch (line.kind) {
				case 'context':
					endRun();
					break;
				case 'deleted':
					hunkOld.push(line.old);
					runOld.push(line.old);
					break;
				case 'added':
					hunkNew.push(line.new);
					runNew.push(line.new);
					break;
			}
		}
		endRun();
		hunkLines.set(hunk.id, {
			old: RangeSet.fromNumbers(hunkOld),
			new: RangeSet.fromNumbers(hunkNew)
		});
		for (const n of hunkOld) allOld.push(n);
		for (const n of hunkNew) allNew.push(n);
	}
	const changed = { old: RangeSet.fromNumbers(allOld), new: RangeSet.fromNumbers(allNew) };
	const lineCount = changed.old.size + changed.new.size;
	return {
		file,
		changed,
		hasLines: lineCount > 0,
		unitCount: lineCount > 0 ? lineCount : 1,
		hunks,
		hunkLines,
		runs
	};
}

/** The changed lines of one side. */
export function changedLines(file: DiffFile, side: Side): RangeSet {
	switch (side) {
		case 'old':
			return file.changed.old;
		case 'new':
			return file.changed.new;
	}
}
