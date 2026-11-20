import { describe, expect, it } from 'vitest';
import { fileCountOf } from '../file-count.tiny.ts';
import { unitCountOf } from '../unit-count.tiny.ts';
import {
	describeChangedFiles,
	describeKeptMarks,
	describeUpdate,
	type UpdateSummary
} from './update-summary.ts';

function summary(values: {
	readonly filesChanged?: number;
	readonly filesGone?: number;
	readonly newToReview?: number;
	readonly newIgnored?: number;
	readonly gone?: number;
	readonly reviewedBefore?: number;
	readonly reviewedKept?: number;
}): UpdateSummary {
	return {
		filesChanged: fileCountOf(values.filesChanged ?? 0),
		filesGone: fileCountOf(values.filesGone ?? 0),
		newToReview: unitCountOf(values.newToReview ?? 0),
		newIgnored: unitCountOf(values.newIgnored ?? 0),
		gone: unitCountOf(values.gone ?? 0),
		reviewedBefore: unitCountOf(values.reviewedBefore ?? 0),
		reviewedKept: unitCountOf(values.reviewedKept ?? 0)
	};
}

describe('an update in words', () => {
	it('says how many files changed and what is new to review', () => {
		expect(describeChangedFiles(summary({ filesChanged: 2, newToReview: 14 }))).toBe(
			'2 files changed: 14 changes new to review.'
		);
		expect(describeChangedFiles(summary({ filesChanged: 1, newToReview: 1, gone: 3 }))).toBe(
			'1 file changed: 1 change new to review and 3 changes no longer in the diff.'
		);
		expect(
			describeChangedFiles(summary({ filesChanged: 3, newToReview: 2, gone: 1, newIgnored: 4 }))
		).toBe(
			'3 files changed: 2 changes new to review, 1 change no longer in the diff and 4 new changes ignored.'
		);
		expect(describeChangedFiles(summary({ filesChanged: 1, gone: 5 }))).toBe(
			'1 file changed: nothing new to review and 5 changes no longer in the diff.'
		);
	});

	it('says so when the diff itself did not change', () => {
		expect(describeChangedFiles(summary({}))).toBe(
			'Nothing new to review: the files changed, but none of the changes this diff shows did.'
		);
	});

	it('says what became of the marks, only when there were some', () => {
		expect(describeKeptMarks(summary({}))).toBeUndefined();
		expect(describeKeptMarks(summary({ reviewedBefore: 1, reviewedKept: 1 }))).toBe(
			'The change you had marked as reviewed is still marked.'
		);
		expect(describeKeptMarks(summary({ reviewedBefore: 20, reviewedKept: 20 }))).toBe(
			'All 20 changes you had marked as reviewed are still marked.'
		);
		expect(describeKeptMarks(summary({ reviewedBefore: 20, reviewedKept: 18 }))).toBe(
			'18 of the 20 changes you had marked as reviewed are still marked; the other 2 changed or are close to a change, so they need another look.'
		);
		expect(describeKeptMarks(summary({ reviewedBefore: 2, reviewedKept: 1 }))).toBe(
			'1 of the 2 changes you had marked as reviewed is still marked; the other one changed or is close to a change, so it needs another look.'
		);
		expect(describeKeptMarks(summary({ reviewedBefore: 3, reviewedKept: 0 }))).toBe(
			'None of the 3 changes you had marked as reviewed are still marked: they changed or are close to a change, so they need another look.'
		);
		expect(describeKeptMarks(summary({ reviewedBefore: 1, reviewedKept: 0 }))).toBe(
			'The change you had marked as reviewed changed or is close to a change, so it needs another look.'
		);
	});

	it('puts the two together', () => {
		expect(
			describeUpdate(
				summary({ filesChanged: 2, newToReview: 14, reviewedBefore: 5, reviewedKept: 5 })
			)
		).toBe(
			'2 files changed: 14 changes new to review. All 5 changes you had marked as reviewed are still marked.'
		);
		expect(describeUpdate(summary({ filesChanged: 1, newToReview: 1 }))).toBe(
			'1 file changed: 1 change new to review.'
		);
	});
});
