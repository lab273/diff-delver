import { describe, expect, it } from 'vitest';
import { parseDraftCommentId } from '../draft-comment-id.tiny.ts';
import { lineNumberOf } from '../line-number.tiny.ts';
import { MAX_COMMENT_LENGTH, describeCommentLines, isCommentBody } from './draft-comment.ts';

describe('a draft comment', () => {
	it('has an id that is a whole number of 1 or more', () => {
		expect(parseDraftCommentId(1).ok).toBe(true);
		expect(parseDraftCommentId(4_000_000).ok).toBe(true);
		for (const wrong of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
			expect(parseDraftCommentId(wrong).ok).toBe(false);
		}
	});

	it('needs words, and not too many', () => {
		expect(isCommentBody('Why?')).toBe(true);
		expect(isCommentBody('  one line\n\n  another  ')).toBe(true);
		expect(isCommentBody('x'.repeat(MAX_COMMENT_LENGTH))).toBe(true);
		expect(isCommentBody('x'.repeat(MAX_COMMENT_LENGTH + 1))).toBe(false);
		for (const empty of ['', ' ', '\n\t ']) expect(isCommentBody(empty)).toBe(false);
	});

	it('names its lines by the side they are on', () => {
		const at = (side: 'old' | 'new', first: number, last: number) =>
			describeCommentLines({ side, first: lineNumberOf(first), last: lineNumberOf(last) });
		expect(at('old', 4, 4)).toBe('Before, line 4');
		expect(at('new', 3, 5)).toBe('After, lines 3–5');
		expect(at('new', 1200, 1201)).toBe('After, lines 1200–1201');
	});
});
