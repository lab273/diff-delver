/**
 * What every tool answer for an agent shares (DESIGN 7.1): its length is
 * bounded, whatever the diff's size, because agent clients cut a tool's output
 * at about 25,000 tokens; it starts by naming the report and the version it is
 * of; and numbers and lists are written the same way everywhere.
 */
import { agentPath, agentPathPieces } from '../diff/agent-text.ts';
import { visibleText } from '../hidden-characters.ts';
import { jsonQuoted } from '../json-quoted.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
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

/**
 * The first line of every answer about a report. Its title can hold a branch
 * name and its repository is a folder's name, so each is written with what
 * cannot be seen, line separators among them, as escapes: it stays one line.
 */
export function headingLine(heading: ReportHeading): string {
	return `Report ${heading.id}: ${visibleText(heading.title)} in ${visibleText(heading.repository)}, version ${String(heading.version)}.`;
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

/**
 * A list in an answer that is not paged, such as the files ignored
 * automatically, holds at most about this many characters, whatever the
 * names in it; the rest are counted. So what comes after it, the address, the
 * next step and the counts, always fits.
 */
export const MAX_LIST_LENGTH = 4_000;

/** One item of such a list is at most this long; a longer one is shortened, keeping its start and end. */
export const MAX_LISTED_ITEM_LENGTH = 600;

/**
 * Names joined with commas: the first `max` of them that fit in
 * `MAX_LIST_LENGTH`, each shortened past `MAX_LISTED_ITEM_LENGTH`, then how
 * many more.
 */
export function namesListed(names: readonly string[], max: number = MAX_NAMED): string {
	const shown: string[] = [];
	let length = 0;
	for (const name of names) {
		if (shown.length >= max) break;
		const item = shortened(name, MAX_LISTED_ITEM_LENGTH);
		if (shown.length > 0 && length + item.length + 2 > MAX_LIST_LENGTH) break;
		shown.push(item);
		length += item.length + 2;
	}
	const more = names.length - shown.length;
	return more === 0 ? shown.join(', ') : `${shown.join(', ')} and ${grouped(more)} more`;
}

/**
 * Text of at most about `max` characters: as it is, or its start and its end
 * with how much was left out between them, never splitting a character.
 */
export function shortened(text: string, max: number): string {
	if (text.length <= max) return text;
	const chars = Array.from(text);
	const keep = Math.max(1, Math.floor((max - 40) / 2));
	if (chars.length <= 2 * keep) return text;
	const left = chars.length - 2 * keep;
	return `${chars.slice(0, keep).join('')}… [${counted(left, 'character', 'characters')} left out] …${chars.slice(-keep).join('')}`;
}

/** A path in a list of an answer is at most this long, as `agentPath` writes it; a longer one is shortened. */
export const MAX_LISTED_PATH_LENGTH = 300;

/**
 * A path in a list of an answer that is not paged: as `agentPath` writes it,
 * or, past `max` characters, only its start and end, marked as shortened so it
 * is never taken for a path to send back, with where to read it whole.
 */
export function listedPath(path: RepoPath, max: number = MAX_LISTED_PATH_LENGTH): TextForAgent {
	const whole = agentPath(path);
	if (whole.length <= max) return whole;
	const { quoted, pieces } = agentPathPieces(path);
	const half = Math.floor(max / 3);
	let start = quoted ? '"' : '';
	let i = 0;
	while (i < pieces.length && start.length + (pieces[i]?.length ?? 0) <= half) {
		start += pieces[i] ?? '';
		i += 1;
	}
	let end = quoted ? '"' : '';
	let j = pieces.length;
	while (j > i && end.length + (pieces[j - 1]?.length ?? 0) <= half) {
		end = `${pieces[j - 1] ?? ''}${end}`;
		j -= 1;
	}
	const left = whole.length - start.length - end.length;
	return textForAgent(
		`[a path shortened here, ${counted(left, 'character', 'characters')} left out: ${start}…${end}; get_manifest lists it whole]`
	);
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
	return jsonQuoted(text).slice(1, -1);
}

/** At most this many sentences of a list, such as the files left out of a snapshot, are written out. */
export const MAX_SENTENCES = 10;

/**
 * Lines that each begin with `prefix`: the first `MAX_SENTENCES` of them that
 * fit in `MAX_LIST_LENGTH`, each shortened past `MAX_LISTED_ITEM_LENGTH`, then
 * how many more.
 */
export function sentencesListed(prefix: string, items: readonly string[]): readonly string[] {
	const shown: string[] = [];
	let length = 0;
	for (const item of items) {
		if (shown.length >= MAX_SENTENCES) break;
		const line = `${prefix}${shortened(item, MAX_LISTED_ITEM_LENGTH)}`;
		if (shown.length > 0 && length + line.length + 1 > MAX_LIST_LENGTH) break;
		shown.push(line);
		length += line.length + 1;
	}
	const more = items.length - shown.length;
	return more > 0 ? [...shown, `${prefix}and ${grouped(more)} more like these.`] : shown;
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
