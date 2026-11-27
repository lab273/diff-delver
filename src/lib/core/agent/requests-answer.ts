/**
 * What `wait_for_requests` and `answer_request` answer (DESIGN 7.1, 7.2): the
 * person's requests handed over, each with what it is about in labels the
 * agent can pass to get_file and get_diff, and what happened to the Delve
 * since the last wait; then what to do next. Bounded: at most
 * `MAX_REQUESTS_PER_WAIT` requests, each question quoted and cut short.
 */
import type { AgentRequestId } from '../agent-request-id.tiny.ts';
import { agentPath } from '../diff/agent-text.ts';
import { jsonQuoted } from '../json-quoted.ts';
import type { ReviewNumber } from '../review-number.tiny.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import {
	anchorForAgent,
	MAX_EXCERPTS,
	MAX_REPLY_LENGTH,
	type AgentRequest
} from '../review/agent-request.ts';
import { counted, headingLine, shortened, type ReportHeading } from './answer.ts';

/** The longest question an answer quotes in full. */
const QUOTED_QUESTION = 1_000;

/** What one `wait_for_requests` call found. */
export interface WaitOutcome {
	/** Requests handed over by this call, now delivered. */
	readonly requests: readonly AgentRequest[];
	/** Requests waiting beyond those handed over, for the next call. */
	readonly more: number;
	/** Requests handed over by an earlier wait and not answered yet, with what they ask. */
	readonly unanswered: readonly AgentRequest[];
	/** Requests handed over earlier and not answered, beyond those listed. */
	readonly moreUnanswered: number;
	/** Whether the wait was stopped before its time, as when diff delver stopped. */
	readonly stopped: boolean;
	/** The version the diff was updated to since the last call; undefined when it was not. */
	readonly updated: RevisionNumber | undefined;
	/** The newest review the person finished since the last call; undefined when none was. */
	readonly finished: ReviewNumber | undefined;
	/** Whether the Delve is closed, so nothing more will come. */
	readonly closed: boolean;
	/** How long the call waited, in whole seconds. */
	readonly waited: number;
}

function requestLines(request: AgentRequest): string {
	return [
		`- Request ${String(request.id)}, about ${anchorForAgent(request.anchor, agentPath)}, asked on version ${String(request.version)}:`,
		`  ${jsonQuoted(shortened(request.question.trim(), QUOTED_QUESTION))}`
	].join('\n');
}

export function renderWaited(heading: ReportHeading, outcome: WaitOutcome): string {
	const out = [headingLine(heading)];
	const events: string[] = [];
	if (outcome.updated !== undefined) {
		events.push(
			`The diff was updated to version ${String(outcome.updated)} since you last waited: read get_coverage, and sort what is new, before you carry on.`
		);
	}
	if (outcome.finished !== undefined) {
		events.push(
			`The person finished review ${String(outcome.finished)}: read it with get_review for report ${heading.id}, and act on it as they ask.`
		);
	}
	if (outcome.closed) {
		events.push('The person closed this Delve, so no more requests will come. Stop waiting.');
	}
	if (outcome.requests.length > 0) {
		out.push(
			`${counted(outcome.requests.length, 'request', 'requests')} from the person, now delivered to you${outcome.more > 0 ? ` (${String(outcome.more)} more wait for your next call)` : ''}:`,
			...outcome.requests.map(requestLines),
			`Answer each with answer_request: read the code first with get_file or get_diff, and point at code with "references" (a path and lines, which diff delver shows beside your answer as excerpts) rather than pasting it. Answer what was asked, plainly; the person reviews the code themselves, so do not review it for them.`
		);
	} else if (outcome.stopped) {
		out.push(
			'The wait was stopped before it ended, as when diff delver stopped or was replaced: nothing was handed over.'
		);
	} else if (!outcome.closed) {
		out.push(
			`No requests from the person in the last ${counted(outcome.waited, 'second', 'seconds')}.`
		);
	}
	out.push(...events);
	if (outcome.unanswered.length > 0) {
		out.push(
			`Delivered earlier and still waiting for your answer (answer these too):`,
			...outcome.unanswered.map(requestLines),
			...(outcome.moreUnanswered > 0
				? [`and ${String(outcome.moreUnanswered)} more, given once you have answered these.`]
				: [])
		);
	}
	if (!outcome.closed) {
		out.push(
			outcome.finished === undefined
				? 'Then call wait_for_requests again to keep listening: while you do, the person sees that an agent is connected.'
				: 'Once you have read the review, call wait_for_requests again if the person wants you to keep listening.'
		);
	}
	return out.join('\n');
}

/** What an `answer_request` call did. */
export interface AnsweredOutcome {
	readonly request: AgentRequestId;
	/** Whether this answer was stored, or passed over as the same as the last one. */
	readonly stored: boolean;
	readonly excerpts: number;
	readonly answers: number;
}

export function renderAnswered(heading: ReportHeading, outcome: AnsweredOutcome): string {
	return [
		headingLine(heading),
		outcome.stored
			? `Your answer to request ${String(outcome.request)} is on the person's page, beside what they asked about${outcome.excerpts > 0 ? `, with ${counted(outcome.excerpts, 'excerpt', 'excerpts')} of code` : ''}.`
			: `Request ${String(outcome.request)} has that answer already, so it was passed over: sending a call again adds nothing more.`,
		`The request has ${counted(outcome.answers, 'answer', 'answers')}. If you are listening for the person's questions, call wait_for_requests again for the next one.`
	].join('\n');
}

/** What answer_request takes, in words, for its description and refusals. */
export const ANSWER_BOUNDS = `at most ${String(MAX_REPLY_LENGTH)} characters of Markdown and ${String(MAX_EXCERPTS)} references`;
