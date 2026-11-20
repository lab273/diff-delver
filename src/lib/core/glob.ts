/**
 * Glob patterns over repository paths, as an agent or a project config writes them.
 *
 * - `*` matches within one path segment, `?` one character other than `/`.
 * - `**` as a whole segment matches any number of segments, including none:
 *   `src/**\/*.ts`, `**\/fixtures/**`.
 * - `[abc]`, `[a-z]` and `[!abc]` match one character from a class.
 * - `{a,b}` matches either alternative; alternatives can nest.
 * - `\` makes the next character literal, inside a class too: `[\d]` is the
 *   letter d.
 * - A pattern with no `/` matches the file's name at any depth, as in
 *   `.gitignore`: `*.min.js` matches `dist/app.min.js`. A pattern with a `/` is
 *   matched against the whole path from the root, and a leading `/` only says so:
 *   `/README.md` matches `README.md` but not `docs/README.md`.
 * - A trailing `/` names a directory: `vendor/` is `vendor/**`.
 *
 * Matching is case-sensitive, like git.
 */
import { err, ok, type Result } from './result.ts';
import { textForAgent, type TextForAgent } from './text-for-agent.tiny.ts';

/** Why a glob pattern cannot be used. */
export type GlobProblem =
	| 'empty'
	| 'nul-byte'
	| 'unclosed-class'
	| 'unclosed-brace'
	| 'trailing-escape'
	/** A class range whose end comes before its start, such as `[z-a]`. */
	| 'bad-range';

/** What is wrong with a glob, in words, with what to write instead. */
export function describeGlobProblem(problem: GlobProblem): TextForAgent {
	return textForAgent(globProblemText(problem));
}

function globProblemText(problem: GlobProblem): string {
	switch (problem) {
		case 'empty':
			return 'it is empty';
		case 'nul-byte':
			return 'it holds a NUL character, which no path can contain';
		case 'unclosed-class':
			return 'a "[" has no closing "]"; write "\\[" for a literal bracket';
		case 'unclosed-brace':
			return 'a "{" has no closing "}"; write "\\{" for a literal brace';
		case 'trailing-escape':
			return 'it ends with "\\", which escapes nothing; write "\\\\" for a literal backslash';
		case 'bad-range':
			return 'a range in "[...]" ends before it starts; write it low to high, as in "[a-z]"';
	}
}

/**
 * One character as a regular expression that matches exactly it. Letters and
 * digits stand for themselves; everything else is written as a code point escape,
 * which is valid anywhere in a `u` pattern, inside a class or out. So no text from
 * a pattern ever reaches `RegExp` with a meaning of its own.
 */
function literal(char: string): string {
	if (/^[A-Za-z0-9_]$/.test(char)) return char;
	return `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`;
}

/** The regular expression a glob pattern stands for, or why it has none. */
export function globToRegExp(pattern: string): Result<RegExp, GlobProblem> {
	if (pattern === '') return err('empty');
	if (pattern.includes('\0')) return err('nul-byte');
	const rooted = pattern.startsWith('/');
	let body = rooted ? pattern.slice(1) : pattern;
	if (body.endsWith('/')) body = `${body}**`;
	const anywhere = !rooted && !body.includes('/');
	// Code points, not UTF-16 units, so a character outside the BMP is one character.
	const translated = translate(Array.from(body), 0, false);
	if (!translated.ok) return translated;
	// `s`: a path may hold newlines and other line terminators, and `.` must match them.
	return ok(new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${translated.value.regex}$`, 'su'));
}

interface Translated {
	readonly regex: string;
	/** Index just after what was read. */
	readonly end: number;
}

/**
 * Translates `chars` from `start`. Inside braces it stops at a `,` or `}` at its
 * own level and leaves it for the caller.
 */
function translate(
	chars: readonly string[],
	start: number,
	inBraces: boolean
): Result<Translated, GlobProblem> {
	let regex = '';
	let i = start;
	while (i < chars.length) {
		const c = chars[i] ?? '';
		if (inBraces && (c === ',' || c === '}')) break;
		if (c === '\\') {
			const next = chars[i + 1];
			if (next === undefined) return err('trailing-escape');
			regex += literal(next);
			i += 2;
		} else if (c === '*') {
			let j = i;
			while (chars[j] === '*') j += 1;
			const segmentStart = i === 0 || chars[i - 1] === '/';
			const segmentEnd = j === chars.length || chars[j] === '/';
			if (j - i >= 2 && segmentStart && segmentEnd) {
				if (chars[j] === '/') {
					regex += '(?:.*/)?';
					j += 1;
				} else {
					regex += '.*';
				}
			} else {
				regex += '[^/]*';
			}
			i = j;
		} else if (c === '?') {
			regex += '[^/]';
			i += 1;
		} else if (c === '[') {
			const cls = characterClass(chars, i);
			if (!cls.ok) return cls;
			regex += cls.value.regex;
			i = cls.value.end;
		} else if (c === '{') {
			const alternatives: string[] = [];
			let j = i + 1;
			for (;;) {
				const part = translate(chars, j, true);
				if (!part.ok) return part;
				alternatives.push(part.value.regex);
				j = part.value.end;
				if (chars[j] === ',') j += 1;
				else if (chars[j] === '}') break;
				else return err('unclosed-brace');
			}
			regex += `(?:${alternatives.join('|')})`;
			i = j + 1;
		} else {
			regex += literal(c);
			i += 1;
		}
	}
	return ok({ regex, end: i });
}

/**
 * Reads `[...]` from `open`. A `]` right after the `[` (or after `[!`) is a member,
 * a `-` between two members makes a range, and a `\` makes the next character a
 * plain member: `[\d]` is the letter d, not a digit.
 */
function characterClass(chars: readonly string[], open: number): Result<Translated, GlobProblem> {
	let i = open + 1;
	let negate = false;
	if (chars[i] === '!' || chars[i] === '^') {
		negate = true;
		i += 1;
	}
	/** Reads one member at `i`: the character, and the index after it. */
	const member = (at: number): Result<{ char: string; end: number }, GlobProblem> => {
		const c = chars[at];
		if (c === undefined) return err('unclosed-class');
		if (c !== '\\') return ok({ char: c, end: at + 1 });
		const next = chars[at + 1];
		if (next === undefined) return err('trailing-escape');
		return ok({ char: next, end: at + 2 });
	};

	let members = '';
	let first = true;
	while (i < chars.length) {
		if (chars[i] === ']' && !first) {
			return ok({ regex: negate ? `[^/${members}]` : `[${members}]`, end: i + 1 });
		}
		first = false;
		const low = member(i);
		if (!low.ok) return low;
		i = low.value.end;
		// A range, unless the `-` is the last character before the closing `]`.
		if (chars[i] === '-' && chars[i + 1] !== undefined && chars[i + 1] !== ']') {
			const high = member(i + 1);
			if (!high.ok) return high;
			const from = low.value.char.codePointAt(0) ?? 0;
			const to = high.value.char.codePointAt(0) ?? 0;
			if (to < from) return err('bad-range');
			members += `${literal(low.value.char)}-${literal(high.value.char)}`;
			i = high.value.end;
		} else {
			members += literal(low.value.char);
		}
	}
	return err('unclosed-class');
}
