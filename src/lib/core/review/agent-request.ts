/**
 * The reviewer's requests to the agent (DESIGN 5 `request`, 7.2): a question
 * about lines, a file or a section, which an attached agent takes with
 * `wait_for_requests` and answers with `answer_request`, or which the reviewer
 * copies as a prompt when no agent is attached. Pure: the anchors, the
 * statuses and their words, the bounds, the prompt to copy and the words of a
 * promoted request.
 *
 * A request is conversation, not feedback (DESIGN 6.3): it is never in a
 * finished review unless the reviewer promotes it, which copies the question
 * and the answer into the draft as a comment of their own that says so. Like
 * a comment, it belongs to the version it was asked on and its anchor never
 * changes.
 */
import { visibleText } from '../hidden-characters.ts';
import { jsonQuoted } from '../json-quoted.ts';
import type { AgentMarkdown } from '../agent-markdown.tiny.ts';
import type { AgentRequestId } from '../agent-request-id.tiny.ts';
import { textToCopy, type TextToCopy } from '../agent-setup/text-to-copy.tiny.ts';
import type { LineNumber } from '../line-number.tiny.ts';
import type { LineText } from '../line-text.tiny.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { ReportId } from '../report-id.tiny.ts';
import type { ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import type { SectionId } from '../section-id.tiny.ts';
import type { SectionTitle } from '../section-title.tiny.ts';
import type { Side } from '../side.tiny.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import { describeCommentLines } from './draft-comment.ts';

/** The two questions the Ask box offers ready-made, so nobody has to choose a kind of request. */
export const READY_QUESTIONS = ['Explain this.', 'Show me related code.'] as const;

/** The most characters a question may have. */
export const MAX_QUESTION_LENGTH = 2_000;

/** The most characters one answer's words may have: an explanation, not a document. */
export const MAX_REPLY_LENGTH = 8_000;

/** The most code excerpts one answer may point at. */
export const MAX_EXCERPTS = 10;

/** The most lines of one excerpt that are kept and drawn; a longer range says how many more it has. */
export const MAX_EXCERPT_LINES = 40;

/** The most answers one request may collect, so an agent that loops cannot bury the page. */
export const MAX_ANSWERS = 5;

/** The most requests one `wait_for_requests` hands over; the rest wait for the next call. */
export const MAX_REQUESTS_PER_WAIT = 10;

/**
 * What a request is about: lines on one side of a file of the diff (named by
 * the diff's path for it, as get_diff names it), a whole file, or a section,
 * with its title as it was when asked.
 */
export type RequestAnchor =
	| {
			readonly kind: 'lines';
			readonly path: RepoPath;
			readonly side: Side;
			readonly first: LineNumber;
			readonly last: LineNumber;
	  }
	| { readonly kind: 'file'; readonly path: RepoPath }
	| { readonly kind: 'section'; readonly section: SectionId; readonly title: SectionTitle };

/**
 * Where a request is: waiting for an agent to take it, delivered to one that
 * has not answered yet, answered, or cancelled by the reviewer.
 */
export type RequestStatus = 'waiting' | 'delivered' | 'answered' | 'cancelled';

/** Lines of a file the agent pointed at, as the snapshot held them when it answered. */
export interface RequestExcerpt {
	readonly path: RepoPath;
	readonly side: Side;
	readonly first: LineNumber;
	/** The last line the agent named, which may be past the lines kept. */
	readonly last: LineNumber;
	/** The lines from `first`, at most `MAX_EXCERPT_LINES` of them. */
	readonly lines: readonly LineText[];
}

/** One answer of the agent: its words, to be drawn as agent text, and the code it pointed at. */
export interface RequestAnswer {
	readonly body: AgentMarkdown;
	readonly answeredAt: Timestamp;
	/** The version the agent answered on, whose snapshot its excerpts are from. */
	readonly version: RevisionNumber;
	readonly excerpts: readonly RequestExcerpt[];
}

export interface AgentRequest {
	readonly id: AgentRequestId;
	/** The version it was asked on. */
	readonly version: RevisionNumber;
	readonly anchor: RequestAnchor;
	/** The reviewer's words, exactly as typed. */
	readonly question: string;
	readonly askedAt: Timestamp;
	readonly status: RequestStatus;
	/** Whether the reviewer copied it into the draft as a comment. */
	readonly promoted: boolean;
	readonly answers: readonly RequestAnswer[];
}

/** Whether `text` can be asked: something written, and not too long. */
export function isQuestion(text: string): boolean {
	return text.trim() !== '' && text.length <= MAX_QUESTION_LENGTH;
}

/** A request's status in words, as the page says it beside "Question for the agent". */
export function requestStatusWords(status: RequestStatus, connected: boolean): string {
	switch (status) {
		case 'waiting':
			return connected ? 'Waiting for the agent' : 'Not sent yet: no agent is connected';
		case 'delivered':
			return 'The agent has it';
		case 'answered':
			return 'Answered';
		case 'cancelled':
			return 'Cancelled';
	}
}

/** Whether the reviewer can still cancel a request: no agent has answered it. */
export function isOpenRequest(status: RequestStatus): boolean {
	return status === 'waiting' || status === 'delivered';
}

/** What a request is about, in the page's words: "After, lines 3–5", "the whole file". */
export function describeRequestAnchor(anchor: RequestAnchor): string {
	switch (anchor.kind) {
		case 'lines':
			return describeCommentLines(anchor);
		case 'file':
			return 'the whole file';
		case 'section':
			return `the section “${visibleText(anchor.title)}”`;
	}
}

/**
 * A run of lines as get_diff and get_file label them: `+40..+46` on the new
 * side, `-12` on the old.
 */
export function lineLabels(side: Side, first: LineNumber, last: LineNumber): string {
	const sign = side === 'new' ? '+' : '-';
	return first === last
		? `${sign}${String(first)}`
		: `${sign}${String(first)}..${sign}${String(last)}`;
}

/**
 * What a request is about, for an agent, with the path written as `path`
 * gives it (escaped and quoted when odd): `src/a.ts, lines +4..+6 (the new
 * side)`, `src/a.ts, the whole file`, `the section "auth" (“Sign-in”)`.
 */
export function anchorForAgent(anchor: RequestAnchor, path: (p: RepoPath) => string): string {
	switch (anchor.kind) {
		case 'lines':
			return `${path(anchor.path)}, lines ${lineLabels(anchor.side, anchor.first, anchor.last)} (the ${anchor.side} side)`;
		case 'file':
			return `${path(anchor.path)}, the whole file`;
		case 'section':
			return `the section ${jsonQuoted(anchor.section)} (${jsonQuoted(anchor.title)})`;
	}
}

/** The Delve a prompt names, as `sortRequest` names one. */
export interface DelveAsked {
	readonly id: ReportId;
	readonly title: ReviewerMessage;
	readonly repository: ReviewerMessage;
}

/**
 * The prompt "Copy as prompt" gives when no agent is attached: one paragraph
 * any agent with diff delver's tools can act on, naming the report and the
 * request, what is asked about and the question, and how to answer so the
 * answer appears beside the code. What cannot be seen is written out, so
 * nothing unseen is pasted.
 */
export function requestPrompt(
	delve: DelveAsked,
	request: Pick<AgentRequest, 'id' | 'anchor' | 'question'>,
	path: (p: RepoPath) => string
): TextToCopy {
	const what = `“${visibleText(delve.title)}” in ${visibleText(delve.repository)}`;
	return textToCopy(
		`In diff delver report ${delve.id} (${what}), the person reviewing asks about ` +
			`${anchorForAgent(request.anchor, path)}: “${visibleText(request.question.trim())}” ` +
			`Read the code with get_file or get_diff for report ${delve.id}, then answer with ` +
			`answer_request for request ${String(request.id)}, pointing at code by path and lines ` +
			`in "references" rather than pasting it, so the answer appears beside the code in their ` +
			`browser. Answer the question only: the person reviews the code themselves.`
	);
}

/** Text quoted as Markdown, line by line. */
function quoted(text: string): string {
	return text
		.trim()
		.split(/\r\n|\r|\n/)
		.map((line) => (line === '' ? '>' : `> ${line}`))
		.join('\n');
}

/**
 * The words of the comment a promoted request becomes: the question, then the
 * agent's answers quoted under a line that says they are the agent's, so the
 * review never passes them off as the reviewer's own.
 */
export function promotedRequestBody(
	request: Pick<AgentRequest, 'question' | 'answers'>,
	max: number
): string {
	const answers = request.answers.map((a) => quoted(a.body)).join('\n>\n');
	const whole = `I asked the agent:\n${quoted(request.question)}\n\nThe agent answered:\n${answers}`;
	if (whole.length <= max) return whole;
	// Cut where a character ends, never inside one, and say it was cut.
	const end = Math.max(0, max - CUT_SHORT.length);
	const code = whole.charCodeAt(end - 1);
	const at = code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
	return `${whole.slice(0, at)}${CUT_SHORT}`;
}

/** What a promoted request's words end with when they were longer than a comment holds. */
export const CUT_SHORT = '\n\n(Cut short: the answer was longer than a comment holds.)';
