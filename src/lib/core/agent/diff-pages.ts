/**
 * `get_diff` (DESIGN 7.1): the labelled diff text (`renderAgentDiff`) of some
 * files, in pages of about `PAGE_LENGTH` characters. A file is never split
 * across pages unless it is longer than a page by itself; then it is continued
 * on the next, from the hunk header before where the page starts, so every
 * line still carries its label and its hunk. The answer says plainly whether
 * more follows and gives the cursor to read it with.
 */
import { renderAgentFile } from '../diff/agent-text.ts';
import type { DiffFile } from '../diff/diff.ts';
import { textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
import { counted, grouped, headingLine, PAGE_LENGTH, type ReportHeading } from './answer.ts';
import { pageCursor, type CursorPosition } from './page-cursor.tiny.ts';
import { agentPath } from '../diff/agent-text.ts';

export interface DiffPageInput {
	readonly heading: ReportHeading;
	/** Every file of the diff, in the diff's order: a cursor's place is a position in it. */
	readonly files: readonly DiffFile[];
	/** Whether a file is among those asked for, as it is now. */
	readonly selected: (file: DiffFile) => boolean;
	/**
	 * Whether what is selected stays the same between pages, as for paths and
	 * globs. "Only not sorted yet" does not: sorting between pages takes files
	 * out of it, so its pages count what is shown and what is left, not places in a list.
	 */
	readonly stable: boolean;
	/** What was asked for, in words: "the whole diff", "2 files not sorted yet". */
	readonly asked: string;
	/** The key of the filters, for the cursor (`filterKey`). */
	readonly key: string;
	/** How to repeat the call, as JSON fields after "report": `"files": ["src/**"]`. */
	readonly repeat: string;
}

/**
 * Where a page starts: a file of the whole diff and a line of that file's
 * text. The page starts at the first file asked for from there on, so a file
 * that sorting took out of the selection meanwhile is passed over, and none
 * is skipped or shown twice.
 */
export interface PageStart {
	readonly file: number;
	readonly line: number;
}

/** Whether a cursor's position is one this diff could have given. */
export function diffPosition(position: CursorPosition, input: DiffPageInput): boolean {
	if (position.key !== input.key || position.version !== input.heading.version) return false;
	const file = input.files[position.file];
	return file !== undefined && position.line < renderAgentFile(file).split('\n').length;
}

export function renderDiffPage(
	input: DiffPageInput,
	start: PageStart = { file: 0, line: 0 },
	budget = PAGE_LENGTH
): TextForAgent {
	const { heading, files, selected } = input;
	const out: string[] = [headingLine(heading)];
	const first = start.file === 0 && start.line === 0;
	const chosen = (index: number): boolean => {
		const file = files[index];
		return file !== undefined && selected(file);
	};
	const nextChosen = (from: number): number => {
		let at = from;
		while (at < files.length && !chosen(at)) at += 1;
		return at;
	};
	let file = nextChosen(start.file);
	let line = file === start.file ? start.line : 0;
	if (file >= files.length) {
		out.push(
			first
				? `Nothing to show: ${input.asked} has no files.`
				: `Nothing more to show: no file after the last page is among ${input.asked} now. That was the last page.`
		);
		return textForAgent(out.join('\n'));
	}
	const body: string[] = [];
	let length = 0;
	const firstShown = file;
	let shown = 0;
	while (file < files.length) {
		const current = files[file];
		if (current === undefined) break;
		const text = renderAgentFile(current).split('\n');
		const from = line;
		const rest = text.slice(from);
		const restLength = rest.reduce((n, l) => n + l.length + 1, 0);
		if (restLength + length <= budget) {
			if (body.length > 0) body.push('');
			if (from > 0) body.push(...continued(current, text, from));
			body.push(...rest);
			length += restLength + 1;
			shown += 1;
			file = nextChosen(file + 1);
			line = 0;
			continue;
		}
		// Too long for what is left of this page: start the next page with it,
		// unless it is longer than a page by itself, when it is split.
		if (body.length > 0 && restLength <= budget) break;
		if (body.length > 0) body.push('');
		if (from > 0) body.push(...continued(current, text, from));
		let taken = 0;
		for (const piece of rest) {
			if (taken > 0 && length + piece.length + 1 > budget) break;
			body.push(piece);
			length += piece.length + 1;
			taken += 1;
		}
		shown += 1;
		line = from + taken;
		if (line >= text.length) {
			file = nextChosen(file + 1);
			line = 0;
		}
		break;
	}
	const done = file >= files.length;
	const splitLast = line > 0 ? ' (the last one continues on the next page)' : '';
	let more = 0;
	for (let at = line > 0 ? file + 1 : file; at < files.length; at += 1) if (chosen(at)) more += 1;
	let summary: string;
	if (first && done) {
		summary = `${capitalised(input.asked)}: ${counted(shown, 'file', 'files')}, all on this page.`;
	} else if (input.stable) {
		let before = 0;
		for (let at = 0; at < firstShown; at += 1) if (chosen(at)) before += 1;
		const lastRank = before + shown;
		const total = lastRank + more;
		const range =
			shown === 1
				? `file ${grouped(lastRank)}`
				: `files ${grouped(before + 1)} to ${grouped(lastRank)}`;
		summary = `${capitalised(input.asked)}: ${range} of ${grouped(total)}${splitLast}.`;
	} else {
		summary = `${capitalised(input.asked)}: ${counted(shown, 'file', 'files')} on this page${first ? '' : ', after those on earlier pages'}${splitLast}; ${more === 0 ? 'no more after it' : `${counted(more, 'more file', 'more files')} after it, as things stand now`}.`;
	}
	out.push(
		summary,
		'Each changed line starts with the label assign takes for it: +<line> for an added line, -<line> for a deleted one; unchanged lines have no label. Hunks are headed "@@ <hunk id> ...". "file" labels the change to a file itself.',
		'',
		...body
	);
	if (!done) {
		const cursor = pageCursor({ version: heading.version, file, line, key: input.key });
		out.push(
			'',
			`More follows. Call get_diff with "report": "${heading.id}"${input.repeat === '' ? '' : `, ${input.repeat}`} and "cursor": "${cursor}" for the next page.`
		);
	} else if (!first) {
		out.push('', 'That was the last page.');
	}
	return textForAgent(out.join('\n'));
}

function capitalised(text: string): string {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The lines that start a page continuing a file: its heading, and the hunk header the page starts in. */
function continued(file: DiffFile, text: readonly string[], from: number): readonly string[] {
	const out = [`## ${agentPath(file.file.path)} (continued)`];
	const first = text[from] ?? '';
	if (!first.startsWith('@@ ')) {
		for (let i = from - 1; i >= 0; i -= 1) {
			const line = text[i] ?? '';
			if (line.startsWith('@@ ')) {
				out.push(`${line} (continued)`);
				break;
			}
		}
	}
	return out;
}
