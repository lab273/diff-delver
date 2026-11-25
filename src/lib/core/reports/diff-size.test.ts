import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	arbitraryAssignScenario,
	syntheticDiff
} from '../../../../tests/support/synthetic-diff.ts';
import type { BlobId } from '../blob-id.tiny.ts';
import { parseByteSize, type ByteSize } from '../byte-size.tiny.ts';
import { assign } from '../diff/assign.ts';
import { initialState } from '../diff/state.ts';
import { fileCountOf } from '../file-count.tiny.ts';
import { lineCountOf } from '../line-count.tiny.ts';
import { parseRepoPath } from '../repo-path.tiny.ts';
import {
	binaryBlobsOf,
	binaryFilesOf,
	describeBinaryFiles,
	describeDiffSize,
	diffSizeOf,
	isTestPath,
	mainLinesOf,
	NO_BINARY_FILES,
	type BinaryFiles,
	type DiffSize
} from './diff-size.ts';

function bytes(n: number): ByteSize {
	const parsed = parseByteSize(n);
	if (!parsed.ok) throw new Error(String(n));
	return parsed.value;
}

function size(files: number, added: number, removed: number, tests = [0, 0]): DiffSize {
	return {
		files: fileCountOf(files),
		addedLines: lineCountOf(added),
		deletedLines: lineCountOf(removed),
		testLines: { added: lineCountOf(tests[0] ?? 0), removed: lineCountOf(tests[1] ?? 0) }
	};
}

describe('the size of a diff', () => {
	const diff = syntheticDiff([
		{ path: 'a.png', change: 'binary' },
		{ path: 'src/app.test.ts', change: 'added', lines: 3 },
		{ path: 'src/app.ts', change: 'modified', hunks: [{ gap: 0, lines: ['-', '-', '+', ' '] }] }
	]);

	it('counts files and lines, and the lines whose path says they are tests apart', () => {
		expect(diffSizeOf(diff, initialState(diff))).toEqual({
			files: 3,
			addedLines: 4,
			deletedLines: 2,
			testLines: { added: 3, removed: 0 }
		});
	});

	it('counts the roles as stored, so an agent that corrects one is believed', () => {
		const corrected = assign(diff, initialState(diff), [
			{ file: 'src/app.ts', lines: '-1', role: 'test' },
			{ file: 'src/app.test.ts', lines: '+1..+2', role: 'code' }
		]).state;
		const counted = diffSizeOf(diff, corrected);
		expect(counted.testLines).toEqual({ added: 1, removed: 1 });
		expect(mainLinesOf(counted)).toEqual({ added: 3, removed: 1 });
	});

	it('always adds the tests and the rest up to the whole, whatever the roles', () => {
		fc.assert(
			fc.property(arbitraryAssignScenario, ([d, calls]) => {
				let state = initialState(d);
				for (const call of calls) state = assign(d, state, call).state;
				const counted = diffSizeOf(d, state);
				const main = mainLinesOf(counted);
				let added = 0;
				let removed = 0;
				for (const file of d.files) {
					added += file.changed.new.size;
					removed += file.changed.old.size;
				}
				expect(counted.addedLines).toBe(added);
				expect(counted.deletedLines).toBe(removed);
				expect(main.added + counted.testLines.added).toBe(added);
				expect(main.removed + counted.testLines.removed).toBe(removed);
				expect(main.added).toBeGreaterThanOrEqual(0);
				expect(main.removed).toBeGreaterThanOrEqual(0);
			})
		);
	});

	it('tells a test from its path by the rule a first version uses', () => {
		const path = (text: string) => {
			const parsed = parseRepoPath(text);
			if (!parsed.ok) throw new Error(text);
			return parsed.value;
		};
		expect(isTestPath(path('src/app.test.ts'))).toBe(true);
		expect(isTestPath(path('src/__snapshots__/app.test.ts.snap'))).toBe(true);
		expect(isTestPath(path('src/app.ts'))).toBe(false);
	});
});

describe('a diff size in words', () => {
	it('says only the lines when none are tests', () => {
		expect(describeDiffSize(size(3, 40, 12))).toBe(
			'3 files changed, 40 lines added and 12 removed'
		);
		expect(describeDiffSize(size(1, 1, 0))).toBe('1 file changed, 1 line added');
		expect(describeDiffSize(size(2, 0, 5))).toBe('2 files changed, 5 lines removed');
		expect(describeDiffSize(size(1, 0, 0))).toBe('1 file changed, no lines added or removed');
		expect(describeDiffSize(size(0, 0, 0))).toBe('No files changed');
	});

	it('counts the tests apart, so the two add up to the whole', () => {
		expect(describeDiffSize(size(3, 60, 16, [20, 4]))).toBe(
			'3 files changed, 40 lines added and 12 removed, plus 20 added and 4 removed in tests'
		);
		expect(describeDiffSize(size(3, 1, 12, [1, 0]))).toBe(
			'3 files changed, 12 lines removed, plus 1 added in tests'
		);
		expect(describeDiffSize(size(3, 40, 2, [0, 2]))).toBe(
			'3 files changed, 40 lines added, plus 2 removed in tests'
		);
	});

	it('says plainly when every line is a test', () => {
		expect(describeDiffSize(size(2, 20, 0, [20, 0]))).toBe(
			'2 files changed, 20 lines added, all in tests'
		);
		expect(describeDiffSize(size(1, 1, 1, [1, 1]))).toBe(
			'1 file changed, 1 line added and 1 removed, all in tests'
		);
	});
});

describe('binary files', () => {
	const diff = syntheticDiff([
		{ path: 'a.png', change: 'binary' },
		{ path: 'b.ts', change: 'added', lines: 2 },
		{ path: 'c.bin', change: 'mode' }
	]);

	it('names the blobs of each side of each binary file, and counts them with their sizes', () => {
		const blobs = binaryBlobsOf(diff);
		expect(blobs).toHaveLength(2);
		const [before, after] = blobs;
		if (before === undefined || after === undefined) throw new Error('two blobs');
		const sizes = new Map<BlobId, ByteSize>([
			[before, bytes(4096)],
			[after, bytes(5120)]
		]);
		expect(binaryFilesOf(diff, sizes)).toEqual({
			...NO_BINARY_FILES,
			changed: { files: 1, before: 4096, after: 5120 }
		});
	});

	it('has none when no file is binary', () => {
		const text = syntheticDiff([{ path: 'b.ts', change: 'added', lines: 2 }]);
		expect(binaryBlobsOf(text)).toEqual([]);
		expect(binaryFilesOf(text, new Map())).toEqual(NO_BINARY_FILES);
		expect(describeBinaryFiles(NO_BINARY_FILES)).toBeUndefined();
	});

	const files = (
		added: [number, number],
		removed: [number, number],
		changed: [number, number, number]
	): BinaryFiles => ({
		added: { files: fileCountOf(added[0]), bytes: bytes(added[1]) },
		removed: { files: fileCountOf(removed[0]), bytes: bytes(removed[1]) },
		changed: { files: fileCountOf(changed[0]), before: bytes(changed[1]), after: bytes(changed[2]) }
	});

	it('says how many are added, removed and changed, with their sizes', () => {
		expect(describeBinaryFiles(files([1, 12_288], [0, 0], [0, 0, 0]))).toBe(
			'1 binary file added (12 KB)'
		);
		expect(describeBinaryFiles(files([0, 0], [2, 900], [0, 0, 0]))).toBe(
			'2 binary files removed (900 bytes)'
		);
		expect(describeBinaryFiles(files([0, 0], [0, 0], [1, 4096, 5120]))).toBe(
			'1 binary file changed (4 KB to 5 KB)'
		);
		expect(describeBinaryFiles(files([1, 12_288], [1, 3072], [1, 4096, 5120]))).toBe(
			'3 binary files: 1 added (12 KB), 1 removed (3 KB), 1 changed (4 KB to 5 KB)'
		);
		expect(describeBinaryFiles(files([1, 1], [0, 0], [11, 0, 1_572_864]))).toBe(
			'12 binary files: 1 added (1 byte), 11 changed (0 bytes to 1.5 MB)'
		);
	});
});
