/**
 * diff delver's entry in Codex's `config.toml`, changed by `diff-delver setup`
 * as a person would change it by hand: the `[mcp_servers.diff-delver]` table,
 * and any table under it, is found, compared, replaced or removed, and every
 * other byte of the file is kept as it was. Nothing else is read or rewritten,
 * so the file's comments, order and spacing stay the person's.
 *
 * The file is not parsed as a whole. It is scanned line by line, following
 * strings (basic, literal and multi-line) and brackets, only to tell where a
 * table header starts; what our table holds is read with the few rules its
 * `command` and `args` need. An entry for diff delver in any other form, such
 * as a dotted key under `[mcp_servers]` or an inline table, cannot be changed
 * without parsing the file, so it is left alone and said so (`elsewhere`).
 *
 * A table of ours that runs something else keeps everything but its `command`
 * and `args`: the person's other settings, such as `startup_timeout_sec`,
 * `enabled` or an `[mcp_servers.diff-delver.env]` table, stay. What setup
 * writes takes the file's own line ending, so a file written with CRLF stays so.
 */
import { SERVER_NAME } from './agent-server.ts';

/** One line of the file: where it starts and ends (after its line break), and what it is. */
interface ScannedLine {
	readonly start: number;
	readonly end: number;
	/** A table header's path, as its keys, or undefined when the line is no header. */
	readonly header: readonly string[] | undefined;
	/** The first key of a `key = value` line that starts outside any value, with the rest of its dotted path. */
	readonly key: readonly string[] | undefined;
	/** Only white space or a comment. */
	readonly blank: boolean;
	/** Inside a value that an earlier line opened: a multi-line string, array or inline table. */
	readonly continued: boolean;
}

/** The line ending a file uses: CRLF when its first line ends so, else LF. */
export function lineEndingOf(text: string): '\n' | '\r\n' {
	const newline = text.indexOf('\n');
	return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
}

/** Reads a key path, `a.b."c d".'e'`, from `text`; undefined when it is not one. */
function keyPath(text: string): string[] | undefined {
	const keys: string[] = [];
	let i = 0;
	const space = (): void => {
		while (text[i] === ' ' || text[i] === '\t') i += 1;
	};
	for (;;) {
		space();
		const c = text[i];
		if (c === '"') {
			const read = basicString(text, i);
			if (read === undefined) return undefined;
			keys.push(read.value);
			i = read.end;
		} else if (c === "'") {
			const close = text.indexOf("'", i + 1);
			if (close < 0) return undefined;
			keys.push(text.slice(i + 1, close));
			i = close + 1;
		} else {
			const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
			if (bare === null) return undefined;
			keys.push(bare[0]);
			i += bare[0].length;
		}
		space();
		if (text[i] !== '.') break;
		i += 1;
	}
	return i === text.length ? keys : undefined;
}

/** A TOML basic string starting at `from` (its opening quote): its value and where it ends. */
function basicString(text: string, from: number): { value: string; end: number } | undefined {
	let value = '';
	for (let i = from + 1; i < text.length; i += 1) {
		const c = text.charAt(i);
		if (c === '"') return { value, end: i + 1 };
		if (c === '\n') return undefined;
		if (c !== '\\') {
			value += c;
			continue;
		}
		i += 1;
		const e = text[i];
		const simple: Record<string, string> = {
			b: '\b',
			t: '\t',
			n: '\n',
			f: '\f',
			r: '\r',
			e: '\u001b',
			'"': '"',
			'\\': '\\'
		};
		if (e !== undefined && e in simple) {
			value += simple[e] ?? '';
		} else if (e === 'u' || e === 'U') {
			const length = e === 'u' ? 4 : 8;
			const hex = text.slice(i + 1, i + 1 + length);
			if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== length) return undefined;
			const point = Number.parseInt(hex, 16);
			if (point > 0x10ffff) return undefined;
			value += String.fromCodePoint(point);
			i += length;
		} else {
			return undefined;
		}
	}
	return undefined;
}

/**
 * The file's lines, each with whether it is a table header or a key line. A
 * line inside a multi-line string, or inside an array or inline table that
 * spans lines, is neither, so a `[` there is never taken for a header.
 */
function scan(text: string): ScannedLine[] {
	const lines: ScannedLine[] = [];
	let i = 0;
	/** Inside a multi-line string, its closing quotes. */
	let inside: '"""' | "'''" | undefined;
	/** Open brackets and braces of a value that spans lines. */
	let depth = 0;
	while (i < text.length) {
		const start = i;
		const newline = text.indexOf('\n', i);
		const end = newline < 0 ? text.length : newline + 1;
		const whole = text.slice(start, newline < 0 ? text.length : newline);
		// A CRLF file's lines end in a carriage return, which is no part of them.
		const line = whole.endsWith('\r') ? whole.slice(0, -1) : whole;
		const wasInValue = inside !== undefined || depth > 0;
		let header: string[] | undefined;
		let key: string[] | undefined;
		let j = 0;
		if (!wasInValue) {
			const trimmed = line.trimStart();
			j = line.length - trimmed.length;
			if (trimmed.startsWith('[')) {
				const array = trimmed.startsWith('[[');
				const open = array ? 2 : 1;
				const close = findHeaderClose(trimmed, open, array);
				if (close !== undefined) header = keyPath(trimmed.slice(open, close).trim());
				j = line.length;
			} else {
				const equals = keyEnd(trimmed);
				if (equals !== undefined) {
					key = keyPath(trimmed.slice(0, equals).trim());
					j += equals + 1;
				} else j = line.length;
			}
		}
		// The rest of the line: strings, comments and brackets, carried to the next line.
		while (j < line.length) {
			if (inside !== undefined) {
				const close = line.indexOf(inside, j);
				if (close < 0) break;
				// A basic multi-line string's quotes may be escaped.
				if (inside === '"""' && escaped(line, close)) {
					j = close + 1;
					continue;
				}
				j = close + 3;
				while (line[j] === inside[0]) j += 1;
				inside = undefined;
				continue;
			}
			const c = line[j];
			if (c === '#') break;
			if (c === '"' || c === "'") {
				const triple = line.startsWith(c.repeat(3), j);
				if (triple) {
					inside = c === '"' ? '"""' : "'''";
					j += 3;
					continue;
				}
				j = stringEnd(line, j, c);
				continue;
			}
			if (c === '[' || c === '{') depth += 1;
			if ((c === ']' || c === '}') && depth > 0) depth -= 1;
			j += 1;
		}
		lines.push({
			start,
			end,
			header: wasInValue ? undefined : header,
			key: wasInValue ? undefined : key,
			blank: !wasInValue && /^\s*(#.*)?$/.test(line),
			continued: wasInValue
		});
		i = end;
	}
	return lines;
}

function escaped(line: string, at: number): boolean {
	let slashes = 0;
	for (let k = at - 1; k >= 0 && line[k] === '\\'; k -= 1) slashes += 1;
	return slashes % 2 === 1;
}

/** Where a one-line string that opens at `from` ends, or the line's end. */
function stringEnd(line: string, from: number, quote: string): number {
	for (let k = from + 1; k < line.length; k += 1) {
		if (quote === '"' && line[k] === '\\') {
			k += 1;
			continue;
		}
		if (line[k] === quote) return k + 1;
	}
	return line.length;
}

/** Where a header's closing bracket is, past any quoted keys in it. */
function findHeaderClose(text: string, from: number, array: boolean): number | undefined {
	for (let k = from; k < text.length; k += 1) {
		const c = text[k];
		if (c === '"' || c === "'") {
			k = stringEnd(text, k, c) - 1;
			continue;
		}
		if (c === ']') return array && text[k + 1] !== ']' ? undefined : k;
	}
	return undefined;
}

/** Where a key line's `=` is, past any quoted keys before it. */
function keyEnd(text: string): number | undefined {
	for (let k = 0; k < text.length; k += 1) {
		const c = text[k];
		if (c === '#') return undefined;
		if (c === '"' || c === "'") {
			k = stringEnd(text, k, c) - 1;
			continue;
		}
		if (c === '=') return k;
	}
	return undefined;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
	return prefix.every((key, i) => path[i] === key);
}

const OUR_TABLE = ['mcp_servers', SERVER_NAME] as const;

/** The program and arguments an MCP server entry runs. */
export interface ServerCommand {
	readonly command: string;
	readonly args: readonly string[];
}

/** Where something is in the file, from its first byte to just after its last. */
interface Span {
	readonly start: number;
	readonly end: number;
}

/** What the file holds for diff delver. */
export type CodexEntry =
	| { readonly kind: 'none' }
	/**
	 * Our table: its text, exactly as in the file, what it runs when that could
	 * be read, the end of its header line, and its `command` and `args` lines.
	 */
	| {
			readonly kind: 'table';
			readonly text: string;
			readonly runs: ServerCommand | undefined;
			readonly start: number;
			readonly end: number;
			readonly headerEnd: number;
			readonly command: Span | undefined;
			readonly args: Span | undefined;
	  }
	/** An entry for diff delver in a form this cannot change: a dotted key, an inline table. */
	| { readonly kind: 'elsewhere' };

/**
 * diff delver's entry in `text`, a `config.toml`. The table runs from its
 * header to its last line that is not blank or a comment, with any table under
 * it (`[mcp_servers.diff-delver.env]`) that follows it; blank lines and comments
 * after that belong to what comes next.
 */
export function findCodexEntry(text: string): CodexEntry {
	const lines = scan(text);
	let table: readonly string[] = [];
	let first: number | undefined;
	let last: number | undefined;
	let elsewhere = false;
	let ended = false;
	const fields = new Map<string, { start: number; end: number }>();
	/** The key line of our own table that the lines continuing a value belong to. */
	let lastKey: { start: number; end: number } | undefined;
	for (const [index, line] of lines.entries()) {
		if (line.continued) {
			if (lastKey !== undefined) lastKey.end = line.end;
		} else lastKey = undefined;
		if (line.header !== undefined) {
			table = line.header;
			const ours = startsWith(table, OUR_TABLE);
			if (ours && first === undefined) first = index;
			else if (ours && ended) elsewhere = true;
			else if (!ours && first !== undefined) ended = true;
			if (ours && !ended) last = index;
			continue;
		}
		if (line.key !== undefined) {
			const full = [...table, ...line.key];
			const inOurs = startsWith(table, OUR_TABLE);
			const own = inOurs && table.length === OUR_TABLE.length && first !== undefined && !ended;
			const name = line.key.length === 1 ? line.key[0] : undefined;
			if (own && name !== undefined && !fields.has(name)) {
				lastKey = { start: line.start, end: line.end };
				fields.set(name, lastKey);
			}
			if (inOurs && first !== undefined && !ended) last = index;
			else if (startsWith(full, OUR_TABLE)) elsewhere = true;
			// `mcp_servers = { … }` at the top: a table of ours added after it would be no TOML.
			else if (full.length === 1 && full[0] === OUR_TABLE[0]) elsewhere = true;
			continue;
		}
		// A line inside a value that spans lines belongs to the key line before it.
		if (!line.blank && first !== undefined && !ended && startsWith(table, OUR_TABLE)) last = index;
	}
	if (elsewhere) return { kind: 'elsewhere' };
	if (first === undefined || last === undefined) return { kind: 'none' };
	const start = lines[first]?.start ?? 0;
	const end = lines[last]?.end ?? text.length;
	const own = text.slice(start, end);
	return {
		kind: 'table',
		text: own,
		runs: readCommand(own),
		start,
		end,
		headerEnd: lines[first]?.end ?? end,
		command: fields.get('command'),
		args: fields.get('args')
	};
}

/** What a table of ours runs: its `command` and `args`, when both are plain strings. */
function readCommand(table: string): ServerCommand | undefined {
	const lines = table.split('\n');
	// Only the table's own lines, before any table under it.
	const under = lines.findIndex((line, i) => i > 0 && /^\s*\[\s*[A-Za-z0-9_"'-]/.test(line));
	const body = lines.slice(1, under < 0 ? lines.length : under).join('\n');
	const command = /^\s*command\s*=\s*/m.exec(body);
	const args = /^\s*args\s*=\s*/m.exec(body);
	if (command === null) return undefined;
	const program = readString(body, command.index + command[0].length);
	if (program === undefined) return undefined;
	if (args === null) return { command: program.value, args: [] };
	let i = args.index + args[0].length;
	if (body[i] !== '[') return undefined;
	i += 1;
	const values: string[] = [];
	for (;;) {
		i = skipSpace(body, i);
		if (body[i] === ']') break;
		const value = readString(body, i);
		if (value === undefined) return undefined;
		values.push(value.value);
		i = skipSpace(body, value.end);
		if (body[i] === ',') i += 1;
		else if (body[i] !== ']') return undefined;
	}
	return { command: program.value, args: values };
}

function skipSpace(text: string, from: number): number {
	let i = from;
	for (;;) {
		while (i < text.length && /\s/.test(text[i] ?? '')) i += 1;
		if (text[i] !== '#') return i;
		while (i < text.length && text[i] !== '\n') i += 1;
	}
}

function readString(text: string, from: number): { value: string; end: number } | undefined {
	if (text[from] === '"' && !text.startsWith('"""', from)) return basicString(text, from);
	if (text[from] === "'" && !text.startsWith("'''", from)) {
		const close = text.indexOf("'", from + 1);
		const value = text.slice(from + 1, close);
		return close < 0 || value.includes('\n') ? undefined : { value, end: close + 1 };
	}
	return undefined;
}

export function sameCommand(a: ServerCommand, b: ServerCommand): boolean {
	return (
		a.command === b.command &&
		a.args.length === b.args.length &&
		a.args.every((arg, i) => arg === b.args[i])
	);
}

/** What setting diff delver up in a `config.toml` does to it. */
export type CodexChange =
	| { readonly kind: 'added'; readonly text: string }
	| { readonly kind: 'unchanged' }
	/**
	 * Our table ran something else: its `command` and `args` are ours now and
	 * the rest is kept. `before` is the whole table as it was.
	 */
	| { readonly kind: 'replaced'; readonly text: string; readonly before: string }
	| { readonly kind: 'elsewhere' };

/** Text of the file as a person reads it in a message: LF line endings, nothing trailing. */
function shown(text: string): string {
	return text.replaceAll('\r\n', '\n').trimEnd();
}

/**
 * The file with diff delver's table, `entry` (as `codexConfigEntry` writes
 * it: header, `command` and `args` lines, without a line break at its end), in
 * it: added at the end, after a blank line, or, where a table of ours runs
 * something else, its `command` and `args` put in place of that table's, so
 * its other settings stay.
 */
export function addCodexEntry(text: string, entry: string, runs: ServerCommand): CodexChange {
	const found = findCodexEntry(text);
	const eol = lineEndingOf(text);
	switch (found.kind) {
		case 'elsewhere':
			return found;
		case 'table': {
			if (found.runs !== undefined && sameCommand(found.runs, runs)) return { kind: 'unchanged' };
			const [, commandLine = '', argsLine = ''] = entry.split('\n');
			const edits: { start: number; end: number; text: string }[] = [];
			const both = `${commandLine}${eol}${argsLine}${eol}`;
			if (found.command !== undefined && found.args !== undefined) {
				edits.push({ ...found.command, text: `${commandLine}${eol}` });
				edits.push({ ...found.args, text: `${argsLine}${eol}` });
			} else if (found.command !== undefined || found.args !== undefined) {
				const span = found.command ?? found.args ?? { start: 0, end: 0 };
				edits.push({ ...span, text: both });
			} else {
				const header = text.slice(found.start, found.headerEnd);
				// A header on the file's last line, with no line break after it yet.
				const lead = header.endsWith('\n') ? '' : eol;
				edits.push({ start: found.headerEnd, end: found.headerEnd, text: `${lead}${both}` });
			}
			let changed = text;
			for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
				changed = `${changed.slice(0, edit.start)}${edit.text}${changed.slice(edit.end)}`;
			}
			return { kind: 'replaced', text: changed, before: shown(found.text) };
		}
		case 'none': {
			const lines = entry.split('\n').join(eol);
			if (text === '') return { kind: 'added', text: `${lines}${eol}` };
			const ended = text.endsWith('\n') ? text : `${text}${eol}`;
			return { kind: 'added', text: `${ended}${eol}${lines}${eol}` };
		}
	}
}

/** What undoing setup does to a `config.toml`. */
export type CodexRemoval =
	| { readonly kind: 'removed'; readonly text: string }
	| { readonly kind: 'none' }
	/** A table of ours that runs something else, which this copy did not add. */
	| { readonly kind: 'other'; readonly before: string }
	| { readonly kind: 'elsewhere' };

/**
 * The file without diff delver's table, when it runs what `runs` says: the
 * table goes, with the one blank line that setup put before it when nothing
 * follows it, so a file set up and then undone is as it was.
 */
export function removeCodexEntry(text: string, runs: ServerCommand): CodexRemoval {
	const found = findCodexEntry(text);
	switch (found.kind) {
		case 'none':
		case 'elsewhere':
			return found;
		case 'table': {
			if (found.runs === undefined || !sameCommand(found.runs, runs)) {
				return { kind: 'other', before: shown(found.text) };
			}
			const eol = lineEndingOf(text);
			let start = found.start;
			let end = found.end;
			const after = text.slice(end);
			const blankBefore = text.slice(0, start).endsWith(`${eol}${eol}`);
			if (/^\s*$/.test(after)) {
				end = text.length;
				if (blankBefore) start -= eol.length;
			} else if (blankBefore && after.startsWith(eol)) {
				end += eol.length;
			}
			return { kind: 'removed', text: `${text.slice(0, start)}${text.slice(end)}` };
		}
	}
}
