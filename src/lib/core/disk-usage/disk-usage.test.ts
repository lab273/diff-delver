import { describe, expect, it } from 'vitest';
import { parseByteSize, type ByteSize } from '../byte-size.tiny.ts';
import { delveSizes, totalDiskUsage, type DelveDiskUsage } from './delve-sizes.ts';
import {
	describeDiskUsage,
	describeDiskUsageInFull,
	describeMeasuredSize,
	describeWhatDeletingFrees
} from './disk-words.ts';
import { parseTimestamp, type Timestamp } from '../timestamp.tiny.ts';

function time(ms: number): Timestamp {
	const parsed = parseTimestamp(ms);
	if (!parsed.ok) throw new Error('not a time');
	return parsed.value;
}

function size(n: number): ByteSize {
	const parsed = parseByteSize(n);
	if (!parsed.ok) throw new Error('not a size');
	return parsed.value;
}

function usage(own: number, shared: number): DelveDiskUsage {
	return { own: size(own), shared: size(shared) };
}

const MB = 1024 * 1024;

describe('what each Delve takes on disk', () => {
	// a 10, b 20 and c 40 bytes: the first reaches a, b and c; the second c and d, of 80.
	const reach = (r: number, others: number): { reach: ByteSize; others: ByteSize } => ({
		reach: size(r),
		others: size(others)
	});

	it('counts what one Delve alone reaches as its own and the rest as shared', () => {
		const measured = delveSizes(
			size(150),
			new Map([
				['first', reach(70, 120)],
				['second', reach(120, 70)]
			])
		);
		expect(measured.get('first')).toEqual(usage(30, 40));
		expect(measured.get('second')).toEqual(usage(80, 40));
	});

	it('gives a Delve alone in its store all it reaches, and one that reaches nothing nothing', () => {
		expect(delveSizes(size(30), new Map([['only', reach(30, 0)]])).get('only')).toEqual(
			usage(30, 0)
		);
		const measured = delveSizes(
			size(30),
			new Map([
				['first', reach(30, 30)],
				['second', reach(30, 30)],
				['empty', reach(0, 30)]
			])
		);
		expect(measured.get('first')).toEqual(usage(0, 30));
		expect(measured.get('empty')).toEqual(usage(0, 0));
	});

	it('never says less than nothing, nor more than a Delve reaches, when measures disagree', () => {
		const measured = delveSizes(size(100), new Map([['first', reach(40, 120)]]));
		expect(measured.get('first')).toEqual(usage(0, 40));
		const more = delveSizes(size(200), new Map([['first', reach(40, 10)]]));
		expect(more.get('first')).toEqual(usage(40, 0));
	});

	it('adds a Delve up over stores', () => {
		expect(totalDiskUsage([usage(1, 2), usage(3, 4)])).toEqual(usage(4, 6));
		expect(totalDiskUsage([])).toEqual(usage(0, 0));
	});
});

describe('what a Delve takes on disk, in words', () => {
	it('says the own figure on the list, with "about"', () => {
		expect(describeDiskUsage(usage(40 * MB, 2 * MB))).toBe('About 40 MB on disk');
		expect(describeDiskUsage(usage(1536, 0))).toBe('About 1.5 KB on disk');
		expect(describeDiskUsage(usage(10, 5 * MB))).toBe('Almost nothing on disk of its own');
		expect(describeDiskUsage(usage(10, 0))).toBe('Almost nothing on disk');
	});

	it('says both figures in full', () => {
		expect(describeDiskUsageInFull(usage(40 * MB, 2 * MB))).toBe(
			'Deleting it frees about 40 MB. About 2 MB more is shared with other Delves of this repository, and stays.'
		);
		expect(describeDiskUsageInFull(usage(40 * MB, 0))).toBe('Deleting it frees about 40 MB.');
		expect(describeDiskUsageInFull(usage(0, 0))).toBe('Deleting it frees almost nothing.');
	});

	it('says what deleting frees, and when', () => {
		expect(describeWhatDeletingFrees(usage(40 * MB, 0))).toBe(
			'Deleting it frees about 40 MB on disk within about an hour.'
		);
		expect(describeWhatDeletingFrees(usage(0, 3 * MB))).toBe(
			'It frees almost no space on disk: what it holds is shared with other Delves of this repository.'
		);
		expect(describeWhatDeletingFrees(usage(0, 0))).toBe('It takes almost no space on disk.');
		expect(describeWhatDeletingFrees(undefined)).toBe(
			'The space it takes on disk is freed within about an hour.'
		);
	});

	it("says a store's or the database's size exactly, with when it was measured", () => {
		const now = time(1_700_000_000_000);
		expect(
			describeMeasuredSize({ onDisk: size(12 * MB), measuredAt: time(now - 5 * 60_000) }, now)
		).toBe('12 MB on disk, measured 5 minutes ago');
		expect(describeMeasuredSize(undefined, now)).toBe('Not measured yet');
	});
});
