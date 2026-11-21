/**
 * `get_file` (DESIGN 7.1): lines of any file of either side of the snapshot,
 * for context, numbered as get_diff numbers them, at most `MAX_FILE_LINES` at
 * once and never longer than a page, with the range to ask for next.
 */
import type { ByteSize } from '../byte-size.tiny.ts';
import type { LineText } from '../line-text.tiny.ts';
import type { LineNumber } from '../line-number.tiny.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { Side } from '../side.tiny.ts';
import { textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
import { DEFAULT_MAX_LINE_LENGTH, agentPath, hiddenShown } from '../diff/agent-text.ts';
import { counted, grouped, headingLine, PAGE_LENGTH, type ReportHeading } from './answer.ts';

/** The most lines one call gives. */
export const MAX_FILE_LINES = 1_000;

export interface FileAnswerInput {
	readonly heading: ReportHeading;
	readonly path: RepoPath;
	readonly side: Side;
	readonly lines: readonly { readonly number: LineNumber; readonly text: LineText | string }[];
	/** How many lines the file has in all. */
	readonly lineCount: number;
}

/**
 * A size, true to the byte: "512 bytes", "8 MiB (8,388,608 bytes)", "8.6 MiB
 * (9,000,000 bytes)", in units of 1,024 named as such, so a size one byte
 * over a limit never reads as the limit.
 */
export function bytesInWords(size: ByteSize): string {
	if (size < 1024) return counted(size, 'byte', 'bytes');
	const units = ['KiB', 'MiB', 'GiB', 'TiB'];
	let value = size / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const whole = Number.isInteger(value);
	const shown = whole ? grouped(value) : (Math.floor(value * 10) / 10).toFixed(1);
	return `${shown} ${units[unit] ?? 'TiB'} (${counted(size, 'byte', 'bytes')})`;
}

export function sideInWords(side: Side): string {
	switch (side) {
		case 'old':
			return 'the old side (before the change)';
		case 'new':
			return 'the new side (after the change)';
	}
}

export function renderFileLines(input: FileAnswerInput, budget = PAGE_LENGTH): TextForAgent {
	const { lines } = input;
	const first = lines[0]?.number;
	const out: string[] = [headingLine(input.heading)];
	if (first === undefined) {
		out.push(
			input.lineCount === 0
				? `${agentPath(input.path)} is empty on ${sideInWords(input.side)}.`
				: `${agentPath(input.path)} has ${counted(input.lineCount, 'line', 'lines')} on ${sideInWords(input.side)}, so there is nothing at the lines asked for. Ask for "lines": "1..${String(Math.min(input.lineCount, MAX_FILE_LINES))}".`
		);
		return textForAgent(out.join('\n'));
	}
	const width = String(lines.at(-1)?.number ?? first).length;
	const body: string[] = [];
	let length = 0;
	let last = first - 1;
	for (const line of lines) {
		const text =
			line.text.length > DEFAULT_MAX_LINE_LENGTH
				? `${line.text.slice(0, DEFAULT_MAX_LINE_LENGTH)}… [${String(line.text.length - DEFAULT_MAX_LINE_LENGTH)} more characters]`
				: line.text;
		const shown = `${String(line.number).padStart(width)}  ${hiddenShown(text)}`.trimEnd();
		if (body.length > 0 && length + shown.length + 1 > budget) break;
		body.push(shown);
		length += shown.length + 1;
		last = line.number;
	}
	out.push(
		`${agentPath(input.path)}, ${sideInWords(input.side)}: lines ${grouped(first)} to ${grouped(last)} of ${grouped(input.lineCount)}.`,
		'',
		...body
	);
	if (last < input.lineCount) {
		const next = last + 1;
		const end = Math.min(input.lineCount, last + MAX_FILE_LINES);
		out.push(
			'',
			`More lines follow: ask for "lines": "${String(next)}..${String(end)}" to read on.`
		);
	}
	return textForAgent(out.join('\n'));
}
