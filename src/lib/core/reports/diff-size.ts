/**
 * The size of a diff (DESIGN 4.4): how many files it changes, how many lines it
 * adds and removes, how many of those are tests, and its binary files with
 * their sizes in bytes. Lines of role `test` or `snapshot` are "tests"; the
 * rest are the diff's own lines, so the two always add up to the whole.
 *
 * A diff that has a Delve counts its tests by the roles it has stored, so an
 * agent's correction counts; one that has none yet, such as a commit on the
 * choose page, by the path rule the first version uses (`guessRole`).
 */
import type { BlobId } from '../blob-id.tiny.ts';
import { parseByteSize, type ByteSize } from '../byte-size.tiny.ts';
import { guessRole } from '../diff/path-rules.ts';
import type { Diff } from '../diff/diff.ts';
import { fileAssignment, type Assignment, type AssignmentState } from '../diff/state.ts';
import { fileCountOf, type FileCount } from '../file-count.tiny.ts';
import { lineCountOf, type LineCount } from '../line-count.tiny.ts';
import type { RangeMap } from '../range-map.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { Role } from '../role.tiny.ts';
import { countOf, describeByteSize, formatCount } from '../viewer/words.ts';

/** Lines added and removed. */
export interface LineTally {
	readonly added: LineCount;
	readonly removed: LineCount;
}

export const NO_LINES: LineTally = { added: lineCountOf(0), removed: lineCountOf(0) };

/** The size of a diff in files and lines. */
export interface DiffSize {
	readonly files: FileCount;
	/** Every line added, tests among them. */
	readonly addedLines: LineCount;
	/** Every line removed, tests among them. */
	readonly deletedLines: LineCount;
	/** Of those, the lines that are tests (role `test` or `snapshot`). */
	readonly testLines: LineTally;
}

/** Whether a role makes a line one of the tests. */
export function isTestRole(role: Role): boolean {
	switch (role) {
		case 'test':
		case 'snapshot':
			return true;
		case 'code':
			return false;
	}
}

/** Whether a file with no Delve yet is a test, by the path rule a first version uses. */
export function isTestPath(path: RepoPath): boolean {
	return isTestRole(guessRole(path));
}

function testLinesIn(map: RangeMap<Assignment>): number {
	let count = 0;
	for (const segment of map.segments) {
		if (isTestRole(segment.value.role)) count += segment.last - segment.first + 1;
	}
	return count;
}

/** How many files a diff changes and how many lines it adds and removes, tests by their stored roles. */
export function diffSizeOf(diff: Diff, state: AssignmentState): DiffSize {
	let added = 0;
	let deleted = 0;
	let testAdded = 0;
	let testDeleted = 0;
	for (const file of diff.files) {
		added += file.changed.new.size;
		deleted += file.changed.old.size;
		const assignment = fileAssignment(state, file);
		testAdded += testLinesIn(assignment.new);
		testDeleted += testLinesIn(assignment.old);
	}
	return {
		files: fileCountOf(diff.files.length),
		addedLines: lineCountOf(added),
		deletedLines: lineCountOf(deleted),
		testLines: { added: lineCountOf(testAdded), removed: lineCountOf(testDeleted) }
	};
}

/** The lines that are not tests: the whole less the tests. */
export function mainLinesOf(size: DiffSize): LineTally {
	return {
		added: lineCountOf(size.addedLines - size.testLines.added),
		removed: lineCountOf(size.deletedLines - size.testLines.removed)
	};
}

function hasLines(lines: LineTally): boolean {
	return lines.added > 0 || lines.removed > 0;
}

/** "40 lines added and 12 removed", "40 lines added", "12 lines removed". */
function linesInWords(lines: LineTally): string {
	const { added, removed } = lines;
	if (removed === 0) return `${countOf(added, 'line', 'lines')} added`;
	if (added === 0) return `${countOf(removed, 'line', 'lines')} removed`;
	return `${countOf(added, 'line', 'lines')} added and ${formatCount(removed)} removed`;
}

/** "40 added and 12 removed", without the word "lines", for a count that follows one. */
function moreLinesInWords(lines: LineTally): string {
	const { added, removed } = lines;
	if (removed === 0) return `${formatCount(added)} added`;
	if (added === 0) return `${formatCount(removed)} removed`;
	return `${formatCount(added)} added and ${formatCount(removed)} removed`;
}

/**
 * A diff's size in words, tests counted apart: "3 files changed, 40 lines
 * added and 12 removed, plus 20 added and 4 removed in tests"; "2 files
 * changed, 20 lines added, all in tests".
 */
export function describeDiffSize(size: DiffSize): ReviewerMessage {
	if (size.files === 0) return reviewerMessage('No files changed');
	const files = `${countOf(size.files, 'file', 'files')} changed`;
	const main = mainLinesOf(size);
	const tests = size.testLines;
	if (!hasLines(main) && !hasLines(tests)) {
		return reviewerMessage(`${files}, no lines added or removed`);
	}
	if (!hasLines(tests)) return reviewerMessage(`${files}, ${linesInWords(main)}`);
	if (!hasLines(main)) return reviewerMessage(`${files}, ${linesInWords(tests)}, all in tests`);
	return reviewerMessage(
		`${files}, ${linesInWords(main)}, plus ${moreLinesInWords(tests)} in tests`
	);
}

/** Some binary files and their sizes together. */
export interface BinaryFileCount {
	readonly files: FileCount;
	readonly bytes: ByteSize;
}

/** Binary files whose bytes changed, and their sizes together before and after. */
export interface ChangedBinaryFiles {
	readonly files: FileCount;
	readonly before: ByteSize;
	readonly after: ByteSize;
}

/**
 * A diff's binary files, which have no lines (DESIGN 4.1), images among them:
 * those it adds with their sizes, those it removes with the sizes they had,
 * and those whose bytes it changes with their sizes before and after. A file
 * only renamed, or whose mode alone changed, is none of them.
 */
export interface BinaryFiles {
	readonly added: BinaryFileCount;
	readonly removed: BinaryFileCount;
	readonly changed: ChangedBinaryFiles;
}

function byteSize(n: number): ByteSize {
	const parsed = parseByteSize(n);
	if (!parsed.ok) throw new RangeError(`Not a size in bytes: ${String(n)}`);
	return parsed.value;
}

export const NO_BINARY_FILES: BinaryFiles = {
	added: { files: fileCountOf(0), bytes: byteSize(0) },
	removed: { files: fileCountOf(0), bytes: byteSize(0) },
	changed: { files: fileCountOf(0), before: byteSize(0), after: byteSize(0) }
};

/** The blobs whose sizes `binaryFilesOf` needs: each side of each binary file of the diff. */
export function binaryBlobsOf(diff: Diff): readonly BlobId[] {
	const blobs = new Set<BlobId>();
	for (const { file } of diff.files) {
		if (file.content.kind !== 'binary') continue;
		if (file.old !== undefined) blobs.add(file.old.blob);
		if (file.new !== undefined) blobs.add(file.new.blob);
	}
	return [...blobs];
}

/** A blob `binaryFilesOf` was not given the size of; a bug in the caller. */
export interface BlobSizeMissing {
	readonly kind: 'BlobSizeMissing';
	readonly blob: BlobId;
}

/**
 * The diff's binary files counted, from the sizes of the blobs `binaryBlobsOf`
 * named. Throws when one is missing, which is the caller's bug.
 */
export function binaryFilesOf(diff: Diff, sizes: ReadonlyMap<BlobId, ByteSize>): BinaryFiles {
	const sizeOf = (blob: BlobId): number => {
		const size = sizes.get(blob);
		if (size === undefined) throw new RangeError(`No size for blob ${blob}`);
		return size;
	};
	let added = 0;
	let addedBytes = 0;
	let removed = 0;
	let removedBytes = 0;
	let changed = 0;
	let before = 0;
	let after = 0;
	for (const { file } of diff.files) {
		if (file.content.kind !== 'binary') continue;
		if (file.old === undefined && file.new !== undefined) {
			added += 1;
			addedBytes += sizeOf(file.new.blob);
		} else if (file.old !== undefined && file.new === undefined) {
			removed += 1;
			removedBytes += sizeOf(file.old.blob);
		} else if (file.old !== undefined && file.new !== undefined) {
			changed += 1;
			before += sizeOf(file.old.blob);
			after += sizeOf(file.new.blob);
		}
	}
	return {
		added: { files: fileCountOf(added), bytes: byteSize(addedBytes) },
		removed: { files: fileCountOf(removed), bytes: byteSize(removedBytes) },
		changed: { files: fileCountOf(changed), before: byteSize(before), after: byteSize(after) }
	};
}

/** How many binary files there are in all. */
export function binaryFileTotal(binary: BinaryFiles): FileCount {
	return fileCountOf(binary.added.files + binary.removed.files + binary.changed.files);
}

/**
 * A diff's binary files in words, or undefined when it has none: "1 binary
 * file added (12 KB)", "2 binary files changed (4 KB to 5 KB)", "3 binary
 * files: 1 added (12 KB), 1 removed (3 KB), 1 changed (4 KB to 5 KB)".
 */
export function describeBinaryFiles(binary: BinaryFiles): ReviewerMessage | undefined {
	const total = binaryFileTotal(binary);
	if (total === 0) return undefined;
	const parts: string[] = [];
	if (binary.added.files > 0) {
		parts.push(
			`${formatCount(binary.added.files)} added (${describeByteSize(binary.added.bytes)})`
		);
	}
	if (binary.removed.files > 0) {
		parts.push(
			`${formatCount(binary.removed.files)} removed (${describeByteSize(binary.removed.bytes)})`
		);
	}
	if (binary.changed.files > 0) {
		const { before, after } = binary.changed;
		parts.push(
			`${formatCount(binary.changed.files)} changed (${describeByteSize(before)} to ${describeByteSize(after)})`
		);
	}
	const [only] = parts;
	if (parts.length === 1 && only !== undefined) {
		// "1 binary file added (12 KB)": the count is the total, so it is said once.
		return reviewerMessage(
			`${countOf(total, 'binary file', 'binary files')}${only.slice(formatCount(total).length)}`
		);
	}
	return reviewerMessage(`${countOf(total, 'binary file', 'binary files')}: ${parts.join(', ')}`);
}
