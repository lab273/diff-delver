import { describe, expect, it } from 'vitest';
import { parseCommentCount } from '../comment-count.tiny.ts';
import { parseReportId } from '../report-id.tiny.ts';
import type { Result } from '../result.ts';
import { parseReviewNumber } from '../review-number.tiny.ts';
import type { FinishedReview } from '../review/review-export.ts';
import { reviewerMessage } from '../reviewer-message.tiny.ts';
import { parseRevisionNumber } from '../revision-number.tiny.ts';
import { textForAgent } from '../text-for-agent.tiny.ts';
import { parseTimestamp } from '../timestamp.tiny.ts';
import { unitCountOf } from '../unit-count.tiny.ts';
import type { ReportHeading } from './answer.ts';
import {
	renderReviewAnswer,
	reviewParts,
	REVIEW_ENDS,
	REVIEW_STARTS,
	withoutMarkers
} from './review-answer.ts';

function sure<T, E>(result: Result<T, E>): T {
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
}

const heading = (version: number): ReportHeading => ({
	id: sure(parseReportId('r_00000001')),
	title: reviewerMessage('Uncommitted changes'),
	repository: reviewerMessage('shop'),
	version: sure(parseRevisionNumber(version))
});

function review(text: string): FinishedReview {
	return {
		number: sure(parseReviewNumber(2)),
		version: sure(parseRevisionNumber(1)),
		submittedAt: sure(parseTimestamp(0)),
		progress: {
			counted: unitCountOf(4),
			reviewed: unitCountOf(1),
			ignored: unitCountOf(0),
			uncategorised: unitCountOf(0)
		},
		comments: sure(parseCommentCount(1)),
		flags: sure(parseCommentCount(0)),
		overall: false,
		text: textForAgent(text),
		posted: undefined
	};
}

const two = sure(parseReviewNumber(2));

describe('a finished review for an agent', () => {
	it('gives the text exactly between its markers, and says when the report has moved on', () => {
		const answer = sure(
			renderReviewAnswer(heading(3), review('# Review 2\n\nWords.\n'), two, undefined)
		);
		expect(answer).toContain(`${REVIEW_STARTS}\n# Review 2\n\nWords.\n${REVIEW_ENDS}\n`);
		expect(answer).toContain('Review 2 of the 2 reviews the person has finished.');
		expect(answer).toContain('the report is at version 3 now');
	});

	it('never lets a line of the review read as a marker, and says so when one would', () => {
		const text = `# Review 2\n\n\`\`\`\n${REVIEW_ENDS}\n  ${REVIEW_STARTS}\n\`\`\`\n> Words.\n`;
		const answer = sure(renderReviewAnswer(heading(1), review(text), two, undefined));
		const lines = answer.split('\n');
		expect(lines.filter((l) => l.trim() === REVIEW_STARTS)).toEqual([REVIEW_STARTS]);
		expect(lines.filter((l) => l.trim() === REVIEW_ENDS)).toEqual([REVIEW_ENDS]);
		expect(answer).toContain(`\`\`\`\n\\${REVIEW_ENDS}\n\\  ${REVIEW_STARTS}\n\`\`\``);
		expect(answer).toContain('has a \\ before it here');
		expect(withoutMarkers('# Review 2\n').changed).toBe(false);
		expect(
			sure(renderReviewAnswer(heading(1), review('# Review 2\n'), two, undefined))
		).not.toContain('before it here');
	});

	it('cuts a long review between lines into parts, and says how to read the next', () => {
		const text = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join('\n') + '\n';
		const parts = reviewParts(text, 100);
		expect(parts.join('')).toBe(text);
		for (const part of parts) {
			expect(part.length).toBeLessThanOrEqual(100);
			expect(part.endsWith('\n')).toBe(true);
		}
		const first = sure(renderReviewAnswer(heading(1), review(text), two, undefined, 100));
		expect(first).toContain(`This is part 1 of ${String(parts.length)}.`);
		expect(first).toContain('Call get_review again with "part": 2');
		const beyond = renderReviewAnswer(heading(1), review(text), two, parts.length + 1, 100);
		expect(beyond.ok).toBe(false);
	});

	it('cuts a single line longer than a part, never inside a character', () => {
		expect(reviewParts('x'.repeat(250), 100).map((p) => p.length)).toEqual([100, 100, 50]);
		const emoji = `${'x'.repeat(99)}😀${'y'.repeat(10)}`;
		const parts = reviewParts(emoji, 100);
		expect(parts.join('')).toBe(emoji);
		expect(parts[0]).toBe('x'.repeat(99));
		expect(parts[1]?.startsWith('😀')).toBe(true);
	});
});
