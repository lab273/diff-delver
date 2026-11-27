import { describe, expect, it } from 'vitest';
import { renderWaited } from '../agent/requests-answer.ts';
import { parseAgentMarkdown } from '../agent-markdown.tiny.ts';
import { parseAgentRequestId, type AgentRequestId } from '../agent-request-id.tiny.ts';
import { parseLineNumber, type LineNumber } from '../line-number.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { parseReportId } from '../report-id.tiny.ts';
import { reviewerMessage } from '../reviewer-message.tiny.ts';
import { parseReviewNumber } from '../review-number.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '../revision-number.tiny.ts';
import { parseSectionId } from '../section-id.tiny.ts';
import { parseSectionTitle } from '../section-title.tiny.ts';
import { parseTimestamp } from '../timestamp.tiny.ts';
import type { Result } from '../result.ts';
import {
	anchorForAgent,
	describeRequestAnchor,
	isQuestion,
	MAX_QUESTION_LENGTH,
	promotedRequestBody,
	CUT_SHORT,
	requestPrompt,
	requestStatusWords,
	requestsAsOf,
	type AgentRequest,
	type RequestAnchor
} from './agent-request.ts';

function v<T>(result: Result<T, unknown>): T {
	if (!result.ok) throw new Error('not valid');
	return result.value;
}

const path: RepoPath = v(parseRepoPath('src/cart.ts'));
const line = (n: number): LineNumber => v(parseLineNumber(n));
const lines: RequestAnchor = { kind: 'lines', path, side: 'new', first: line(3), last: line(5) };
const section: RequestAnchor = {
	kind: 'section',
	section: v(parseSectionId('totals')),
	title: v(parseSectionTitle('Totals round up'))
};
const id: AgentRequestId = v(parseAgentRequestId(7));
const one: RevisionNumber = v(parseRevisionNumber(1));
const report = v(parseReportId('r_7f3a9c01'));

function request(more: Partial<AgentRequest> = {}): AgentRequest {
	return {
		id,
		version: one,
		anchor: lines,
		question: 'Explain this.',
		askedAt: v(parseTimestamp(0)),
		status: 'waiting',
		promoted: false,
		answers: [],
		...more
	};
}

describe('requests to the agent', () => {
	it('says what each is about, to the reviewer and to the agent', () => {
		expect(describeRequestAnchor(lines)).toBe('After, lines 3–5');
		expect(describeRequestAnchor({ kind: 'file', path })).toBe('the whole file');
		expect(describeRequestAnchor(section)).toBe('the section “Totals round up”');
		expect(anchorForAgent(lines, String)).toBe('src/cart.ts, lines +3..+5 (the new side)');
		expect(
			anchorForAgent({ kind: 'lines', path, side: 'old', first: line(2), last: line(2) }, String)
		).toBe('src/cart.ts, lines -2 (the old side)');
		expect(anchorForAgent(section, String)).toBe('the section "totals" ("Totals round up")');
	});

	it('takes a question that is written and not too long', () => {
		expect(isQuestion('Why?')).toBe(true);
		expect(isQuestion(' \n ')).toBe(false);
		expect(isQuestion('a'.repeat(MAX_QUESTION_LENGTH + 1))).toBe(false);
	});

	it('says plainly when a request waits with no agent connected', () => {
		expect(requestStatusWords('waiting', false)).toBe('Not sent yet: no agent is connected');
		expect(requestStatusWords('waiting', true)).toBe('Waiting for the agent');
	});

	it('copies a prompt any agent can act on, with nothing unseen in it', () => {
		const prompt = requestPrompt(
			{
				id: report,
				title: reviewerMessage('Uncommitted changes'),
				repository: reviewerMessage('shop'),
				version: v(parseRevisionNumber(2))
			},
			{ id, anchor: lines, question: 'Why‮here?' },
			String
		);
		expect(prompt).toBe(
			'In diff delver report r_7f3a9c01 (“Uncommitted changes” in shop), the person reviewing asks about src/cart.ts, lines +3..+5 (the new side): “Why\\u202Ehere?” Read the code with get_file or get_diff for report r_7f3a9c01, at version 2, then answer with answer_request for request 7 with "version": 2, pointing at code by path and lines in "references" rather than pasting it, so the answer appears beside the code in their browser. Answer the question only: the person reviews the code themselves.'
		);
	});

	it('quotes the question and the agent when promoted', () => {
		const body = v(parseAgentMarkdown('It rounds.\n\nSee `roundPrice`.'));
		expect(
			promotedRequestBody(
				request({
					answers: [{ body, answeredAt: v(parseTimestamp(1)), version: one, excerpts: [] }]
				}),
				10_000
			)
		).toBe(
			'I asked the agent:\n> Explain this.\n\nThe agent answered:\n> It rounds.\n>\n> See `roundPrice`.'
		);
	});

	it('cuts a promoted request that is too long where a character ends, and says so', () => {
		const body = v(parseAgentMarkdown('\u{1F600}'.repeat(60)));
		const asked = request({
			answers: [{ body, answeredAt: v(parseTimestamp(1)), version: one, excerpts: [] }]
		});
		for (let max = CUT_SHORT.length + 80; max < CUT_SHORT.length + 84; max += 1) {
			const text = promotedRequestBody(asked, max);
			expect(text.endsWith(CUT_SHORT)).toBe(true);
			expect(text.length).toBeLessThanOrEqual(max);
			expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		}
	});

	it('hands requests to the agent quoted, and says what happened since', () => {
		const heading = {
			id: report,
			title: reviewerMessage('Uncommitted changes'),
			repository: reviewerMessage('shop'),
			version: one
		};
		const text = renderWaited(heading, {
			requests: [request({ question: 'Line one\nline "two"' })],
			more: 2,
			unanswered: [],
			moreUnanswered: 0,
			stopped: false,
			updated: undefined,
			finished: undefined,
			closed: false,
			waited: 45
		});
		expect(text).toContain('1 request from the person, now delivered to you (2 more wait');
		expect(text).toContain('  "Line one\\nline \\"two\\""');
		const finished = renderWaited(heading, {
			requests: [],
			more: 0,
			unanswered: [request({ status: 'delivered', question: 'Why?' })],
			moreUnanswered: 3,
			stopped: false,
			updated: v(parseRevisionNumber(2)),
			finished: v(parseReviewNumber(1)),
			closed: false,
			waited: 45
		});
		expect(finished).toContain('No requests from the person in the last 45 seconds.');
		expect(finished).toContain('and 3 more, given once you have answered these.');
		const stopped = renderWaited(heading, {
			requests: [],
			more: 0,
			unanswered: [],
			moreUnanswered: 0,
			stopped: true,
			updated: undefined,
			finished: undefined,
			closed: false,
			waited: 45
		});
		expect(stopped).toContain('The wait was stopped before it ended');
		expect(stopped).not.toContain('No requests from the person');
		expect(finished).toContain('The diff was updated to version 2');
		expect(finished).toContain('The person finished review 1: read it with get_review');
		expect(finished).toContain(
			'Delivered earlier and still waiting for your answer (answer these too):\n- Request 7, about src/cart.ts, lines +3..+5 (the new side), asked on version 1:\n  "Why?"'
		);
	});

	it('stands as it did at a moment: asked by then, with the answers given by then', () => {
		const at = (ms: number) => v(parseTimestamp(ms));
		const answer = {
			body: v(parseAgentMarkdown('Because.')),
			answeredAt: at(20),
			version: one,
			excerpts: []
		};
		const answered = request({ status: 'answered', promoted: true, answers: [answer] });
		const later = request({ id: v(parseAgentRequestId(8)), askedAt: at(30) });
		expect(requestsAsOf([answered, later], at(25))).toEqual([answered]);
		expect(requestsAsOf([answered, later], at(10))).toEqual([
			{ ...answered, status: 'delivered', promoted: false, answers: [] }
		]);
	});
});
