import { describe, expect, it } from 'vitest';
import { parseByteSize, type ByteSize } from '../byte-size.tiny.ts';
import { delveSizes, totalDiskUsage, type DelveDiskUsage } from './delve-sizes.ts';
import {
	describeDiskUsage,
	describeDiskUsageInFull,
	describeWhatDeletingFrees
} from './disk-words.ts';

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
	const sizes = new Map([
		['a', 10],
		['b', 20],
		['c', 40],
		['d', 80]
	]);
	const sizeOf = (o: string): ByteSize | undefined => {
		const found = sizes.get(o);
		return found === undefined ? undefined : size(found);
	};

	it('counts what one Delve alone reaches as its own and the rest as shared', () => {
		const measured = delveSizes(
			new Map([
				['first', ['a', 'b', 'c']],
				['second', ['c', 'd']]
			]),
			sizeOf
		);
		expect(measured.get('first')).toEqual(usage(30, 40));
		expect(measured.get('second')).toEqual(usage(80, 40));
	});

	it('counts an object once however often a Delve reaches it, and nothing for one gone', () => {
		const measured = delveSizes(new Map([['only', ['a', 'a', 'b', 'gone']]]), sizeOf);
		expect(measured.get('only')).toEqual(usage(30, 0));
	});

	it('gives a Delve that reaches nothing no space, and the deletion of one frees what was shared', () => {
		const both = delveSizes(
			new Map([
				['first', ['a', 'b']],
				['second', ['a', 'b']],
				['empty', []]
			]),
			sizeOf
		);
		expect(both.get('first')).toEqual(usage(0, 30));
		expect(both.get('empty')).toEqual(usage(0, 0));
		const after = delveSizes(new Map([['second', ['a', 'b']]]), sizeOf);
		expect(after.get('second')).toEqual(usage(30, 0));
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
		expect(describeWhatDeletingFrees(usage(40 * MB, 0), false)).toBe(
			'Deleting it frees about 40 MB on disk.'
		);
		expect(describeWhatDeletingFrees(usage(40 * MB, 0), true)).toBe(
			'Deleting it frees about 40 MB on disk within an hour.'
		);
		expect(describeWhatDeletingFrees(usage(0, 3 * MB), true)).toBe(
			'It frees almost no space on disk: what it holds is shared with other Delves of this repository.'
		);
		expect(describeWhatDeletingFrees(usage(0, 0), false)).toBe('It takes almost no space on disk.');
		expect(describeWhatDeletingFrees(undefined, false)).toBe(
			'The space it takes on disk is freed within an hour.'
		);
	});
});
