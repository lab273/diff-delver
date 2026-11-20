/**
 * Glob patterns over repository paths, as an agent or a project config writes them.
 *
 * - `*` matches within one path segment, `?` one character other than `/`.
 * - `**` as a whole segment matches any number of segments, including none:
 *   `src/**\/*.ts`, `**\/fixtures/**`.
 * - `[abc]`, `[a-z]` and `[!abc]` match one character from a class.
 * - `{a,b}` matches either alternative; alternatives can nest.
 * - `\` makes the next character literal.
 * - A pattern with no `/` matches the file's name at any depth, as in
 *   `.gitignore`: `*.min.js` matches `dist/app.min.js`. A pattern with a `/` is
 *   matched against the whole path from the root, and a leading `/` only says so:
 *   `/README.md` matches `README.md` but not `docs/README.md`.
 * - A trailing `/` names a directory: `vendor/` is `vendor/**`.
 *
 * Matching is case-sensitive, like git.
 */
import { err, ok, type Result } from './result.ts';

/** Why a glob pattern cannot be used. */
export type GlobProblem =
	'empty' | 'nul-byte' | 'unclosed-class' | 'unclosed-brace' | 'trailing-escape';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;
const escapeRegex = (text: string): string => text.replace(REGEX_SPECIAL, '\\$&');

/** The regular expression a glob pattern stands for, or why it has none. */
export function globToRegExp(pattern: string): Result<RegExp, GlobProblem> {
	if (pattern === '') return err('empty');
	if (pattern.includes('\0')) return err('nul-byte');
	const rooted = pattern.startsWith('/');
	let body = rooted ? pattern.slice(1) : pattern;
	if (body.endsWith('/')) body = `${body}**`;
	const anywhere = !rooted && !body.includes('/');
	const translated = translate(body, 0, false);
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
 * Translates `pattern` from `start`. Inside braces it stops at a `,` or `}` at its
 * own level and leaves it for the caller.
 */
function translate(
	pattern: string,
	start: number,
	inBraces: boolean
): Result<Translated, GlobProblem> {
	let regex = '';
	let i = start;
	while (i < pattern.length) {
		const c = pattern[i] ?? '';
		if (inBraces && (c === ',' || c === '}')) break;
		if (c === '\\') {
			const next = pattern[i + 1];
			if (next === undefined) return err('trailing-escape');
			regex += escapeRegex(next);
			i += 2;
		} else if (c === '*') {
			let j = i;
			while (pattern[j] === '*') j += 1;
			const segmentStart = i === 0 || pattern[i - 1] === '/';
			const segmentEnd = j === pattern.length || pattern[j] === '/';
			if (j - i >= 2 && segmentStart && segmentEnd) {
				if (pattern[j] === '/') {
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
			const cls = characterClass(pattern, i);
			if (!cls.ok) return cls;
			regex += cls.value.regex;
			i = cls.value.end;
		} else if (c === '{') {
			const alternatives: string[] = [];
			let j = i + 1;
			for (;;) {
				const part = translate(pattern, j, true);
				if (!part.ok) return part;
				alternatives.push(part.value.regex);
				j = part.value.end;
				if (pattern[j] === ',') j += 1;
				else if (pattern[j] === '}') break;
				else return err('unclosed-brace');
			}
			regex += `(?:${alternatives.join('|')})`;
			i = j + 1;
		} else {
			regex += escapeRegex(c);
			i += 1;
		}
	}
	return ok({ regex, end: i });
}

function characterClass(pattern: string, open: number): Result<Translated, GlobProblem> {
	let i = open + 1;
	let negate = false;
	if (pattern[i] === '!' || pattern[i] === '^') {
		negate = true;
		i += 1;
	}
	let members = '';
	let first = true;
	while (i < pattern.length) {
		const c = pattern[i] ?? '';
		if (c === ']' && !first) {
			return ok({ regex: negate ? `[^/${members}]` : `[${members}]`, end: i + 1 });
		}
		if (c === '\\') {
			const next = pattern[i + 1];
			if (next === undefined) return err('trailing-escape');
			members += `\\${next}`;
			i += 2;
		} else {
			members += c === '-' ? '-' : c.replace(/[\\\]^[]/g, '\\$&');
			i += 1;
		}
		first = false;
	}
	return err('unclosed-class');
}
