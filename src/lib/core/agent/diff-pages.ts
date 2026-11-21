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
	/** The files asked for, in the diff's order. */
	readonly files: readonly DiffFile[];
	/** What was asked for, in words: "the whole diff", "2 files not sorted yet". */
	readonly asked: string;
	/** The key of the filters, for the cursor (`filterKey`). */
	readonly key: string;
	/** How to repeat the call, as JSON fields after "report": `"files": ["src/**"]`. */
	readonly repeat: string;
}

/** Where a page starts: a file of the list and a line of that file's text. */
export interface PageStart {
	readonly file: number;
	readonly line: number;
}

/** Whether a cursor's position is one this list of files could have given. */
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
	const { heading, files } = input;
	const out: string[] = [headingLine(heading)];
	if (files.length === 0) {
		out.push(`Nothing to show: ${input.asked} has no files.`);
		return textForAgent(out.join('\n'));
	}
	const body: string[] = [];
	let length = 0;
	let file = start.file;
	let line = start.line;
	const firstFile = start.file;
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
			file += 1;
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
		line = from + taken;
		if (line >= text.length) {
			file += 1;
			line = 0;
		}
		break;
	}
	const lastShown = line > 0 ? file : file - 1;
	const range =
		firstFile === lastShown
			? `file ${grouped(firstFile + 1)}`
			: `files ${grouped(firstFile + 1)} to ${grouped(lastShown + 1)}`;
	const whole = start.file === 0 && start.line === 0 && file >= files.length;
	out.push(
		whole
			? `${capitalised(input.asked)}: ${counted(files.length, 'file', 'files')}, all on this page.`
			: `${capitalised(input.asked)}: ${range} of ${grouped(files.length)}${line > 0 ? ' (the last one continues on the next page)' : ''}.`,
		'Each changed line starts with the label assign takes for it: +<line> for an added line, -<line> for a deleted one; unchanged lines have no label. Hunks are headed "@@ <hunk id> ...". "file" labels the change to a file itself.',
		'',
		...body
	);
	if (file < files.length) {
		const cursor = pageCursor({ version: heading.version, file, line, key: input.key });
		out.push(
			'',
			`More follows. Call get_diff with "report": "${heading.id}"${input.repeat === '' ? '' : `, ${input.repeat}`} and "cursor": "${cursor}" for the next page.`
		);
	} else if (!whole) {
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
