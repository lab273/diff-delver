/**
 * Reads the patch text of `git diff-tree -p` output into one section per
 * `diff --git` header, with its hunks.
 *
 * Paths in the patch headers are not read: they are ambiguous for unusual names,
 * and the raw listing gives them exactly. Only the kind of each header line is
 * used, to check the patch against the listing. Hunks are read by their line
 * counts, so a content line can hold any text at all.
 */
import { parseLineCount, type LineCount } from '../line-count.tiny.ts';
import { parseLineNumber, type LineNumber } from '../line-number.tiny.ts';
import { parseLineText, type LineText } from '../line-text.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import type { DiffOutputError } from './diff-output-error.ts';
import type { DiffLine, HunkSpan } from './file-diff.ts';

/** A hunk as read, before it is given its id. */
export interface PatchHunk {
	readonly old: HunkSpan;
	readonly new: HunkSpan;
	readonly heading: LineText;
	readonly lines: readonly DiffLine[];
}

export interface PatchSection {
	readonly newFile: boolean;
	readonly deletedFile: boolean;
	readonly renamed: boolean;
	readonly copied: boolean;
	readonly binary: boolean;
	readonly hunks: readonly PatchHunk[];
}

const SECTION_START = 'diff --git ';
/**
 * Only `\n` ends a line in git's output, and the text has been split on it. The
 * `s` flag lets the heading hold anything else, including the characters that
 * JavaScript's `.` and `$` otherwise treat as line ends (`\r`, U+2028, U+2029).
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/s;
const NO_NEWLINE = '\\';

class Lines {
	readonly #lines: readonly string[];
	#at = 0;

	constructor(text: string) {
		const lines = text.split('\n');
		// The text ends with a newline, which leaves one empty string after it.
		if (lines.at(-1) === '') lines.pop();
		this.#lines = lines;
	}

	get done(): boolean {
		return this.#at >= this.#lines.length;
	}

	/** 1-based number of the next line, for error messages. */
	get lineNumber(): LineNumber {
		const parsed = parseLineNumber(this.#at + 1);
		if (!parsed.ok) throw new RangeError(`Not a line number: ${this.#at + 1}`);
		return parsed.value;
	}

	peek(): string | undefined {
		return this.#lines[this.#at];
	}

	next(): string | undefined {
		const line = this.#lines[this.#at];
		this.#at += 1;
		return line;
	}
}

/** Reads every section of a patch, in order. Empty text has no sections. */
export function parsePatch(text: string): Result<readonly PatchSection[], DiffOutputError> {
	const lines = new Lines(text);
	const sections: PatchSection[] = [];
	while (!lines.done) {
		const section = readSection(lines);
		if (!section.ok) return section;
		sections.push(section.value);
	}
	return ok(sections);
}

function malformed(lines: Lines, detail: string): Result<never, DiffOutputError> {
	return err({ kind: 'MalformedPatch', line: lines.lineNumber, detail });
}

function readSection(lines: Lines): Result<PatchSection, DiffOutputError> {
	const start = lines.peek();
	if (start?.startsWith(SECTION_START) !== true) {
		return malformed(lines, `expected "${SECTION_START}" but found ${JSON.stringify(start)}`);
	}
	lines.next();

	let newFile = false;
	let deletedFile = false;
	let renamed = false;
	let copied = false;
	let binary = false;
	for (;;) {
		const line = lines.peek();
		if (line === undefined || line.startsWith(SECTION_START) || line.startsWith('@@ ')) break;
		lines.next();
		if (line.startsWith('new file mode ')) newFile = true;
		else if (line.startsWith('deleted file mode ')) deletedFile = true;
		else if (line.startsWith('rename from ')) renamed = true;
		else if (line.startsWith('copy from ')) copied = true;
		else if (line.startsWith('Binary files ') && line.endsWith(' differ')) binary = true;
	}

	const hunks: PatchHunk[] = [];
	while (lines.peek()?.startsWith('@@ ') === true) {
		const hunk = readHunk(lines);
		if (!hunk.ok) return hunk;
		hunks.push(hunk.value);
	}
	const after = lines.peek();
	if (after !== undefined && !after.startsWith(SECTION_START)) {
		return malformed(lines, `unexpected line after a hunk: ${JSON.stringify(after.slice(0, 80))}`);
	}
	return ok({ newFile, deletedFile, renamed, copied, binary, hunks });
}

function count(value: string | undefined, fallback: number): Result<LineCount, unknown> {
	return parseLineCount(value === undefined ? fallback : Number(value));
}

function readHunk(lines: Lines): Result<PatchHunk, DiffOutputError> {
	const header = lines.next() ?? '';
	const match = HUNK_HEADER.exec(header);
	if (match === null) return malformed(lines, `unreadable hunk header ${JSON.stringify(header)}`);
	const [, oldStart, oldLength, newStart, newLength, headingText] = match;
	const spans = [count(oldStart, 0), count(oldLength, 1), count(newStart, 0), count(newLength, 1)];
	const heading = parseLineText(headingText ?? '');
	const [os, ol, ns, nl] = spans;
	if (os?.ok !== true || ol?.ok !== true || ns?.ok !== true || nl?.ok !== true || !heading.ok) {
		return malformed(lines, `unreadable hunk header ${JSON.stringify(header)}`);
	}

	const result: DiffLine[] = [];
	let oldLeft: number = ol.value;
	let newLeft: number = nl.value;
	let oldNext: number = os.value;
	let newNext: number = ns.value;
	while (oldLeft > 0 || newLeft > 0) {
		const line = lines.next();
		if (line === undefined) return malformed(lines, 'the patch ends inside a hunk');
		// An empty line is a blank context line written without its leading space.
		const sign = line === '' ? ' ' : line[0];
		const text = parseLineText(line.slice(1));
		if (!text.ok) return malformed(lines, 'a line contains a newline');
		if (sign === ' ' && oldLeft > 0 && newLeft > 0) {
			const old = lineNumber(oldNext);
			const now = lineNumber(newNext);
			if (old === undefined || now === undefined) return malformed(lines, 'bad line number');
			result.push({ kind: 'context', old, new: now, text: text.value, noNewlineAtEnd: false });
			oldNext += 1;
			newNext += 1;
			oldLeft -= 1;
			newLeft -= 1;
		} else if (sign === '-' && oldLeft > 0) {
			const old = lineNumber(oldNext);
			if (old === undefined) return malformed(lines, 'bad line number');
			result.push({ kind: 'deleted', old, text: text.value, noNewlineAtEnd: false });
			oldNext += 1;
			oldLeft -= 1;
		} else if (sign === '+' && newLeft > 0) {
			const now = lineNumber(newNext);
			if (now === undefined) return malformed(lines, 'bad line number');
			result.push({ kind: 'added', new: now, text: text.value, noNewlineAtEnd: false });
			newNext += 1;
			newLeft -= 1;
		} else if (sign === NO_NEWLINE) {
			if (!markNoNewline(result)) return malformed(lines, 'a no-newline marker with no line');
		} else {
			return malformed(
				lines,
				`a line that does not fit the hunk: ${JSON.stringify(line.slice(0, 80))}`
			);
		}
	}
	// The marker for the hunk's last line comes after the counts run out.
	while (lines.peek()?.startsWith(NO_NEWLINE) === true) {
		lines.next();
		if (!markNoNewline(result)) return malformed(lines, 'a no-newline marker with no line');
	}

	return ok({
		old: { start: os.value, length: ol.value },
		new: { start: ns.value, length: nl.value },
		heading: heading.value,
		lines: result
	});
}

function lineNumber(value: number): LineNumber | undefined {
	const parsed = parseLineNumber(value);
	return parsed.ok ? parsed.value : undefined;
}

function markNoNewline(lines: DiffLine[]): boolean {
	const last = lines.pop();
	if (last === undefined) return false;
	lines.push({ ...last, noNewlineAtEnd: true });
	return true;
}
