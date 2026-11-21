/**
 * What every tool answer for an agent shares (DESIGN 7.1): its length is
 * bounded, whatever the diff's size, because agent clients cut a tool's output
 * at about 25,000 tokens; it starts by naming the report and the version it is
 * of; and numbers and lists are written the same way everywhere.
 */
import type { ReportId } from '../report-id.tiny.ts';
import type { ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import { textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';

/** No answer is longer than this, in UTF-16 code units, whatever it holds. */
export const MAX_ANSWER_LENGTH = 60_000;

/** A page of a paged answer holds about this much, leaving room for what goes around it. */
export const PAGE_LENGTH = 40_000;

/** The report an answer is about, and the version of it the answer was read from. */
export interface ReportHeading {
	readonly id: ReportId;
	/** The source in plain words, such as "Uncommitted changes". */
	readonly title: ReviewerMessage;
	/** The repository's folder name. */
	readonly repository: ReviewerMessage;
	readonly version: RevisionNumber;
}

/** The first line of every answer about a report. */
export function headingLine(heading: ReportHeading): string {
	return `Report ${heading.id}: ${heading.title} in ${heading.repository}, version ${String(heading.version)}.`;
}

/** `1,234`: digits grouped in threes, the same on every machine. */
export function grouped(n: number): string {
	const digits = String(Math.trunc(Math.abs(n)));
	const groups: string[] = [];
	for (let end = digits.length; end > 0; end -= 3)
		groups.unshift(digits.slice(Math.max(0, end - 3), end));
	return `${n < 0 ? '-' : ''}${groups.join(',')}`;
}

/** `1 file`, `3 files`. */
export function counted(n: number, one: string, many: string): string {
	return `${grouped(n)} ${n === 1 ? one : many}`;
}

/** Change lines, the unit everything is counted in. */
export function changes(n: number): string {
	return counted(n, 'change line', 'change lines');
}

/** At most this many names are listed in a sentence; the rest are counted. */
export const MAX_NAMED = 20;

/** Names joined with commas, the first `MAX_NAMED` of them, then how many more. */
export function namesListed(names: readonly string[], max: number = MAX_NAMED): string {
	if (names.length <= max) return names.join(', ');
	return `${names.slice(0, max).join(', ')} and ${grouped(names.length - max)} more`;
}

/** `a, b and c`. */
export function listInWords(items: readonly string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** At most this many characters of an agent's own text are repeated in an answer. */
const MAX_ECHOED = 80;

/**
 * The agent's own text, cut and quoted as a JSON string, so it can never break
 * an answer: at most `max` characters of it, and at most twice that once
 * escaped, so text of characters JSON escapes (`\u0001` is six) stays short.
 */
export function quotedAgentText(text: string, max: number = MAX_ECHOED): string {
	const chars = Array.from(text);
	let kept = 0;
	let length = 0;
	for (const char of chars) {
		const escaped = jsonEscaped(char).length;
		if (kept >= max || length + escaped > 2 * max) break;
		kept += 1;
		length += escaped;
	}
	const cut = kept === chars.length ? text : `${chars.slice(0, kept).join('')}…`;
	return `"${jsonEscaped(cut)}"`;
}

/** Text escaped as inside a JSON string, with U+2028 and U+2029 escaped too, so it stays on one line. */
function jsonEscaped(text: string): string {
	return JSON.stringify(text)
		.slice(1, -1)
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

/** At most this many sentences of a list, such as the files left out of a snapshot, are written out. */
export const MAX_SENTENCES = 10;

/** Lines that each begin with `prefix`, the first `MAX_SENTENCES` of them, then how many more. */
export function sentencesListed(prefix: string, items: readonly string[]): readonly string[] {
	const shown = items.slice(0, MAX_SENTENCES).map((item) => `${prefix}${item}`);
	return items.length > MAX_SENTENCES
		? [...shown, `${prefix}and ${grouped(items.length - MAX_SENTENCES)} more like these.`]
		: shown;
}

/**
 * The answer, never longer than `MAX_ANSWER_LENGTH`: anything past it is cut,
 * at a line, with a note saying so. Paged answers never reach it; this is the
 * guarantee for everything else.
 */
export function boundedAnswer(text: string): TextForAgent {
	if (text.length <= MAX_ANSWER_LENGTH) return textForAgent(text);
	const note =
		'\n[The rest of this answer was cut to keep it short enough to read. Ask for less at once: fewer files, or a smaller range.]';
	const room = MAX_ANSWER_LENGTH - note.length;
	const lineEnd = text.lastIndexOf('\n', room);
	return textForAgent(`${text.slice(0, lineEnd > room / 2 ? lineEnd : room)}${note}`);
}
