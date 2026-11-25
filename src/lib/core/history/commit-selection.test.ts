import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCommitId, type CommitId } from '../commit-id.tiny.ts';
import { itemIndexAt } from '../item-index.tiny.ts';
import { EMPTY_TREE } from '../object-format.ts';
import { fileCountOf } from '../file-count.tiny.ts';
import { lineCountOf } from '../line-count.tiny.ts';
import { formatGitSourceSpec } from '../sources/git-source-spec.ts';
import {
	describeCut,
	describeReviewButton,
	describeSelection,
	describeSelectionProblem,
	isSelected,
	NOTHING_SELECTED,
	selectedCount,
	selectionSource,
	tick,
	toggle,
	untick,
	type ChoosableCommit,
	type CommitParent,
	type CommitSelection
} from './commit-selection.ts';
import { parseSubjectLine } from './subject-line.tiny.ts';

function id(n: number): CommitId {
	const parsed = parseCommitId(n.toString(16).padStart(40, '0'));
	if (!parsed.ok) throw new Error('not an id');
	return parsed.value;
}

/** A list of `count` commits, newest first, each the first parent's child; the last has `last` as parent. */
function rows(
	count: number,
	last: CommitParent = { kind: 'commit', commit: id(999) }
): ChoosableCommit[] {
	return Array.from({ length: count }, (_, i) => {
		const subject = parseSubjectLine(`Commit ${String(count - i)}`);
		if (!subject.ok) throw new Error('not a subject');
		return {
			commit: id(count - i),
			subject: subject.value,
			parent: i === count - 1 ? last : { kind: 'commit', commit: id(count - i - 1) }
		};
	});
}

const at = itemIndexAt;

function ticked(selection: CommitSelection, length: number): number[] {
	return Array.from({ length }, (_, i) => i).filter((i) => isSelected(selection, at(i)));
}

describe('choosing commits', () => {
	it('ticks one commit alone, then grows the run to reach a second', () => {
		const one = tick(NOTHING_SELECTED, at(2));
		expect(ticked(one, 6)).toEqual([2]);
		expect(ticked(tick(one, at(5)), 6)).toEqual([2, 3, 4, 5]);
		expect(ticked(tick(one, at(0)), 6)).toEqual([0, 1, 2]);
		expect(ticked(tick(tick(one, at(5)), at(3)), 6)).toEqual([2, 3, 4, 5]);
	});

	it('shrinks the run from either end, and keeps the newer part when one in the middle is unticked', () => {
		const run = tick(tick(NOTHING_SELECTED, at(1)), at(5));
		expect(ticked(untick(run, at(1)).selection, 6)).toEqual([2, 3, 4, 5]);
		expect(ticked(untick(run, at(5)).selection, 6)).toEqual([1, 2, 3, 4]);
		const middle = untick(run, at(3));
		expect(ticked(middle.selection, 6)).toEqual([1, 2]);
		expect(middle.cut).toBe(2);
		expect(describeCut(middle.cut)).toBe(
			'Only commits next to each other can be reviewed as one diff, so the 2 older commits below it were unticked too.'
		);
		expect(describeCut(untick(run, at(4)).cut)).toContain('the older commit below it was');
		expect(describeCut(untick(run, at(5)).cut)).toBeUndefined();
		expect(untick(tick(NOTHING_SELECTED, at(0)), at(0)).selection).toEqual(NOTHING_SELECTED);
	});

	it('is always one unbroken run that holds what was just ticked and not what was just unticked', () => {
		const length = 12;
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: length - 1 }), { maxLength: 40 }),
				(presses) => {
					let selection: CommitSelection = NOTHING_SELECTED;
					for (const press of presses) {
						const before = ticked(selection, length);
						const wasTicked = isSelected(selection, at(press));
						const { selection: after, cut } = toggle(selection, at(press));
						const now = ticked(after, length);
						// One run: the ticked rows are consecutive.
						for (let i = 1; i < now.length; i += 1) expect(now[i]).toBe((now[i - 1] ?? 0) + 1);
						expect(selectedCount(after)).toBe(now.length);
						if (wasTicked) {
							expect(now).not.toContain(press);
							expect(now.every((row) => before.includes(row))).toBe(true);
							expect(before.length - now.length).toBe(cut + 1);
						} else {
							expect(now).toContain(press);
							expect(before.every((row) => now.includes(row))).toBe(true);
							expect(cut).toBe(0);
						}
						selection = after;
					}
				}
			)
		);
	});
});

describe('what the chosen commits open', () => {
	it('opens one commit as a commit, and a run as the range from its oldest commit’s parent', () => {
		const list = rows(5);
		const one = selectionSource(list, tick(NOTHING_SELECTED, at(1)));
		expect(one.ok && formatGitSourceSpec(one.value)).toBe(id(4));
		const run = selectionSource(list, tick(tick(NOTHING_SELECTED, at(1)), at(3)));
		expect(run.ok && formatGitSourceSpec(run.value)).toBe(`${id(1)}...${id(4)}`);
	});

	it('opens a run from the first commit from the empty tree, and refuses one whose parent was not downloaded', () => {
		const first = rows(3, { kind: 'none' });
		const all = selectionSource(first, tick(tick(NOTHING_SELECTED, at(0)), at(2)));
		expect(all.ok && formatGitSourceSpec(all.value)).toBe(`${EMPTY_TREE.sha1}...${id(3)}`);
		const shallow = rows(3, { kind: 'not-downloaded' });
		const cut = selectionSource(shallow, tick(tick(NOTHING_SELECTED, at(0)), at(2)));
		expect(cut.ok ? 'opened' : cut.error.kind).toBe('HistoryNotDownloaded');
		if (!cut.ok) expect(describeSelectionProblem(cut.error)).toContain('shallow clone');
		// Alone, it is the commit source, which says the same when it is opened.
		const alone = selectionSource(shallow, tick(NOTHING_SELECTED, at(2)));
		expect(alone.ok && formatGitSourceSpec(alone.value)).toBe(id(1));
		expect(selectionSource(first, NOTHING_SELECTED).ok).toBe(false);
	});

	it('says what is chosen in plain words, with the size of the diff when it is known', () => {
		const list = rows(5);
		expect(describeSelection(list, NOTHING_SELECTED, undefined)).toContain('No commits ticked yet');
		expect(describeSelection(list, tick(NOTHING_SELECTED, at(0)), undefined)).toBe(
			'1 commit, “Commit 5”'
		);
		const run = tick(tick(NOTHING_SELECTED, at(0)), at(3));
		const size = {
			files: fileCountOf(12),
			addedLines: lineCountOf(340),
			deletedLines: lineCountOf(25),
			testLines: { added: lineCountOf(40), removed: lineCountOf(0) }
		};
		expect(describeSelection(list, run, size)).toBe(
			'4 commits, from “Commit 2” to “Commit 5”: 12 files changed, 300 lines added and 25 removed, plus 40 added in tests'
		);
		expect(describeReviewButton(run)).toBe('Review these 4 commits');
		expect(describeReviewButton(tick(NOTHING_SELECTED, at(2)))).toBe('Review this commit');
	});

	it('writes out what cannot be seen in a subject, and cuts a long one short', () => {
		const [row] = rows(1);
		if (row === undefined) throw new Error('no row');
		const odd = parseSubjectLine(`Fix ‮evil‬ and ${'x'.repeat(80)}`);
		const empty = parseSubjectLine('');
		if (!odd.ok || !empty.ok) throw new Error('not a subject');
		const one = tick(NOTHING_SELECTED, at(0));
		const text = describeSelection([{ ...row, subject: odd.value }], one, undefined);
		expect(text).toContain('\\u202Eevil\\u202C');
		expect(text.endsWith('…”')).toBe(true);
		expect(describeSelection([{ ...row, subject: empty.value }], one, undefined)).toBe(
			'1 commit, a commit with no message'
		);
	});
});
