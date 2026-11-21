/**
 * The diff as labelled text for an LLM (DESIGN 7.1, `get_diff`). Every changed
 * line carries the label `assign` accepts for it: `+<new line>` for an added
 * line, `-<old line>` for a deleted one. Hunks carry their ids. Context lines
 * have no label.
 *
 * ```
 * ## src/auth/session.ts
 * modified
 * @@ h1 -38,3 +38,4 @@ function refresh()
 *      const now = clock.now();
 * -39  if (expired(now)) {
 * +39  if (expired(now, grace)) {
 * +40    log.debug('expired');
 *      }
 * ```
 *
 * A file with a file-level unit (DESIGN 4.1: a change to its name, mode or kind,
 * or a change with no lines) has a line for it before its hunks, labelled `file`,
 * the label `assign` accepts for it in `lines`:
 *
 * ```
 * ## bin/deploy.sh
 * modified, mode 100644 → 100755
 * file made executable
 * @@ h1 -3,1 +3,1 @@
 * ```
 *
 * A path is shown in its escaped form (`path-bytes.ts`): bytes that are not UTF-8
 * as `\xHH`. A path whose shown form holds a quote, a backslash, a character
 * that cannot be seen or turns text round (`hidden-characters.ts`), `: ` or
 * surrounding spaces is written as a JSON string, with each such character as a
 * `\uHHHH` escape, so the agent can copy it exactly; `assign` accepts what that
 * string holds. So `caf\xE9.txt`, with a byte E9 that is not UTF-8, is written
 * `"caf\\xE9.txt"`, and the agent sends `"file": "caf\\xE9.txt"`.
 */
import { characterCount, type CharacterCount } from '../character-count.tiny.ts';
import { fileModeKind, type FileMode, type FileModeKind } from '../file-mode.tiny.ts';
import { escapeCharacter, isHiddenCharacter } from '../hidden-characters.ts';
import { jsonQuoted } from '../json-quoted.ts';
import { escapedRepoPath } from '../path-bytes.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { joinTextForAgent, textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
import type { DiffFile } from './diff.ts';
import type { DiffLine, FileDiff, Hunk, HunkSpan } from './file-diff.ts';
import { describeFileUnit } from './file-unit.ts';
import { FILE_UNIT_LABEL } from './line-spec.ts';

export interface AgentTextOptions {
	/** Longer lines are cut, with a note of how much was left out. */
	readonly maxLineLength?: CharacterCount;
}

/** Lines longer than this are cut by default. Minified code would otherwise flood the agent. */
export const DEFAULT_MAX_LINE_LENGTH: CharacterCount = characterCount(500);

/** How a path is written for the agent: escaped, and as a JSON string when it needs quoting. */
export function agentPath(path: RepoPath): TextForAgent {
	const { quoted, pieces } = agentPathPieces(path);
	const inner = pieces.join('');
	return textForAgent(quoted ? `"${inner}"` : inner);
}

/**
 * A path as `agentPath` writes it, in pieces, one for each character of the
 * path (`\\xFF` for an odd byte in a quoted path), so it can be shortened
 * without splitting an escape; and whether it is written as a JSON string.
 */
export function agentPathPieces(path: RepoPath): { quoted: boolean; pieces: readonly string[] } {
	const shown: string = escapedRepoPath(path);
	// Quotes, backslashes and characters that cannot be seen or turn text round
	// (newline, tab, U+2028, U+202E, U+200B, ...) would make it ambiguous or
	// break the line, and ": " could pass for the end of the path in a line
	// such as the manifest's; inside the quotes each hidden character is an escape.
	const quoted =
		/["\\]|: /.test(shown) || Array.from(shown).some(isHiddenCharacter) || shown.trim() !== shown;
	// Every backslash of an escaped form starts `\\` or `\xHH`; a plain one has none.
	const pieces = shown.match(/\\\\|\\x[0-9A-F]{2}|[\s\S]/gu) ?? [];
	return { quoted, pieces: quoted ? pieces.map((p) => jsonQuoted(p).slice(1, -1)) : pieces };
}

/** One file's diff as labelled text. */
export function renderAgentFile(file: DiffFile, options: AgentTextOptions = {}): TextForAgent {
	const max = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
	const out: string[] = [`## ${agentPath(file.file.path)}`, describeChange(file)];
	const width = labelWidth(file);
	if (file.hasFileUnit) {
		out.push(`${FILE_UNIT_LABEL.padEnd(width)} ${describeFileUnit(file.file)}`);
	}
	for (const hunk of file.hunks.values()) {
		out.push(hunkHeader(hunk));
		for (const line of hunk.lines) {
			out.push(`${label(line).padEnd(width)} ${shown(line.text, max)}`.trimEnd());
			if (line.noNewlineAtEnd) out.push('\\ No newline at end of file');
		}
	}
	return textForAgent(out.join('\n'));
}

/** Several files' diffs, separated by blank lines. */
export function renderAgentDiff(
	files: Iterable<DiffFile>,
	options: AgentTextOptions = {}
): TextForAgent {
	return joinTextForAgent(
		[...files].map((file) => renderAgentFile(file, options)),
		'\n\n'
	);
}

function label(line: DiffLine): string {
	switch (line.kind) {
		case 'context':
			return '';
		case 'added':
			return `+${line.new}`;
		case 'deleted':
			return `-${line.old}`;
	}
}

function labelWidth(file: DiffFile): number {
	const old = file.changed.old.max ?? 0;
	const now = file.changed.new.max ?? 0;
	const lines = String(Math.max(old, now)).length + 1;
	return file.hasFileUnit ? Math.max(lines, FILE_UNIT_LABEL.length) : lines;
}

function span(sign: '-' | '+', s: HunkSpan): string {
	return `${sign}${s.start},${s.length}`;
}

function hunkHeader(hunk: Hunk): string {
	const heading = hunk.heading === '' ? '' : ` ${hiddenShown(hunk.heading)}`;
	return `@@ ${hunk.id} ${span('-', hunk.old)} ${span('+', hunk.new)} @@${heading}`;
}

/**
 * The text of a line, with long lines cut and every character that cannot be
 * seen written as an escape (`hiddenShown`), a trailing carriage return among
 * them.
 */
function shown(text: string, max: number): string {
	const crlf = text.endsWith('\r');
	const body = crlf ? text.slice(0, -1) : text;
	const cut =
		body.length > max ? `${body.slice(0, max)}… [${body.length - max} more characters]` : body;
	return hiddenShown(crlf ? `${cut}\r` : cut);
}

/**
 * A line of a file as the agent reads it: each character that cannot be seen
 * or that turns text round, but for a tab, written as an escape by the rule
 * the page uses (`hidden-characters.ts`): `\r` for a carriage return, `\x1B`
 * for an escape, `\u2028` for a line separator, `\u202E` for a control that
 * reverses text. So a line of code can never start a line of the answer, move
 * a terminal's cursor or read differently from what it holds, and the agent
 * and the person see the same thing.
 */
export function hiddenShown(text: string): string {
	let out = '';
	for (const character of text) {
		out +=
			character !== '\t' && isHiddenCharacter(character) ? escapeCharacter(character) : character;
	}
	return out;
}

const MODE_NAMES: Readonly<Record<FileModeKind, string>> = {
	regular: 'file',
	executable: 'executable file',
	symlink: 'symlink',
	submodule: 'submodule',
	none: 'nothing',
	other: 'special entry'
};

function modeName(mode: FileMode | undefined): string {
	return mode === undefined ? 'nothing' : MODE_NAMES[fileModeKind(mode)];
}

/** The second line of a file's text: how it changed, and how to assign it if it has no lines. */
function describeChange(file: DiffFile): string {
	const f: FileDiff = file.file;
	const parts: string[] = [];
	switch (f.status) {
		case 'added':
		case 'deleted':
		case 'modified':
			parts.push(f.status);
			break;
		case 'renamed':
		case 'copied':
			parts.push(
				`${f.status} from ${f.old === undefined ? 'nowhere' : agentPath(f.old.path)}` +
					(f.similarity === undefined ? '' : ` (${f.similarity}% similar)`)
			);
			break;
		case 'type-changed':
			parts.push(`changed from ${modeName(f.old?.mode)} to ${modeName(f.new?.mode)}`);
			break;
	}
	if (
		f.status !== 'type-changed' &&
		f.old !== undefined &&
		f.new !== undefined &&
		f.old.mode !== f.new.mode
	) {
		parts.push(`mode ${f.old.mode} → ${f.new.mode}`);
	}
	switch (f.content.kind) {
		case 'binary':
			parts.push('binary');
			break;
		case 'submodule':
			parts.push(
				`submodule ${f.old?.blob.slice(0, 12) ?? 'none'} → ${f.new?.blob.slice(0, 12) ?? 'none'}`
			);
			break;
		case 'text':
			break;
	}
	if (!file.hasLines) parts.push('no changed lines: assign the whole file');
	return parts.join(', ');
}
