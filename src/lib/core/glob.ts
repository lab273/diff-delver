/**
 * Glob patterns over repository paths, as an agent or a project config writes them.
 *
 * - `*` matches within one path segment, `?` one character other than `/`.
 * - `**` as a whole segment matches any number of segments, including none:
 *   `src/**\/*.ts`, `**\/fixtures/**`.
 * - `[abc]`, `[a-z]` and `[!abc]` match one character from a class. A class never
 *   matches `/`, like `*` and `?`: a range that spans it leaves it out, and a `/`
 *   written in a class is refused.
 * - `{a,b}` matches either alternative; alternatives can nest.
 * - `\` makes the next character literal, inside a class too: `[\d]` is the
 *   letter d.
 * - A pattern with no `/` matches the file's name at any depth, as in
 *   `.gitignore`: `*.min.js` matches `dist/app.min.js`. A pattern with a `/` is
 *   matched against the whole path from the root, and a leading `/` only says so:
 *   `/README.md` matches `README.md` but not `docs/README.md`.
 * - A trailing `/` names a directory: `vendor/` is `vendor/**`.
 * - A pattern is at most `MAX_GLOB_LENGTH` characters.
 *
 * Matching is case-sensitive, like git.
 *
 * Patterns come from the agent and run against every file of the diff on the
 * server's one thread, so matching must take bounded time for every pattern. A
 * pattern is compiled to a nondeterministic automaton (Thompson's construction)
 * and run over the path keeping the set of states it could be in, never
 * backtracking. The automaton has at most two states and two edges per pattern
 * character, plus three states and two edges, so a match takes at most
 * `(path length + 1) * (states + edges)` steps (`globStepBound`): linear in the
 * path and linear in the pattern, whatever the pattern holds.
 */
import { err, ok, type Result } from './result.ts';
import { textForAgent, type TextForAgent } from './text-for-agent.tiny.ts';

/** The longest glob pattern accepted, in characters (code points). */
export const MAX_GLOB_LENGTH = 256;

/** Why a glob pattern cannot be used. */
export type GlobProblem =
	| 'empty'
	| 'nul-byte'
	| 'too-long'
	| 'unclosed-class'
	| 'unclosed-brace'
	| 'trailing-escape'
	/** A class range whose end comes before its start, such as `[z-a]`. */
	| 'bad-range'
	/** A `/` inside `[...]`, which a class can never match. */
	| 'slash-in-class';

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
		case 'too-long':
			return `it is longer than ${String(MAX_GLOB_LENGTH)} characters; split it into several shorter globs, one per item`;
		case 'unclosed-class':
			return 'a "[" has no closing "]"; write "\\[" for a literal bracket';
		case 'unclosed-brace':
			return 'a "{" has no closing "}"; write "\\{" for a literal brace';
		case 'trailing-escape':
			return 'it ends with "\\", which escapes nothing; write "\\\\" for a literal backslash';
		case 'bad-range':
			return 'a range in "[...]" ends before it starts; write it low to high, as in "[a-z]"';
		case 'slash-in-class':
			return 'a "[...]" class holds "/", but a class matches one character of a name, never the "/" between folders; write the "/" outside the brackets';
	}
}

// --- The automaton ---------------------------------------------------------------

/** What one edge reads: one character, given as a code point. */
type Test =
	| { readonly kind: 'any' }
	| { readonly kind: 'not-slash' }
	| { readonly kind: 'code'; readonly code: number }
	| { readonly kind: 'class'; readonly takes: (code: number) => boolean };

const ANY = 0;
const NOT_SLASH = 1;
const CODE = 2;
const CLASS = 3;

/**
 * A compiled glob, in flat arrays so that running it allocates nothing per step.
 * Build it once with `compileGlobProgram` and run it on many paths.
 *
 * The edges out of state `s` are `edgeStart[s]` up to `edgeStart[s + 1]`, and
 * likewise the empty links, which lead to another state without reading.
 */
export interface GlobProgram {
	readonly states: number;
	readonly linkStart: Int32Array;
	readonly linkTo: Int32Array;
	readonly edgeStart: Int32Array;
	readonly edgeTo: Int32Array;
	/** `ANY`, `NOT_SLASH`, `CODE` or `CLASS`. */
	readonly edgeKind: Uint8Array;
	/** The code point for `CODE`, the index into `classes` for `CLASS`. */
	readonly edgeArg: Int32Array;
	readonly classes: readonly ((code: number) => boolean)[];
	readonly start: number;
	readonly accept: number;
	/** The state sets met so far, which grows as the program runs (`runGlobProgram`). */
	readonly cache: SetCache;
}

const SLASH = 0x2f;
const anyChar: Test = { kind: 'any' };
const notSlash: Test = { kind: 'not-slash' };
const slash: Test = { kind: 'code', code: SLASH };

class Builder {
	readonly links: number[][] = [];
	readonly edges: { readonly to: number; readonly test: Test }[][] = [];

	state(): number {
		this.links.push([]);
		this.edges.push([]);
		return this.links.length - 1;
	}

	link(from: number, to: number): void {
		this.links[from]?.push(to);
	}

	edge(from: number, to: number, test: Test): void {
		this.edges[from]?.push({ to, test });
	}

	/** A fresh state with a loop reading `test`, entered from `from`. */
	loop(from: number, test: Test): number {
		const at = this.state();
		this.link(from, at);
		this.edge(at, at, test);
		return at;
	}

	program(start: number, accept: number): GlobProgram {
		const states = this.links.length;
		const linkStart = new Int32Array(states + 1);
		const edgeStart = new Int32Array(states + 1);
		const linkTo: number[] = [];
		const edgeTo: number[] = [];
		const edgeKind: number[] = [];
		const edgeArg: number[] = [];
		const classes: ((code: number) => boolean)[] = [];
		for (let s = 0; s < states; s += 1) {
			linkStart[s] = linkTo.length;
			edgeStart[s] = edgeTo.length;
			linkTo.push(...(this.links[s] ?? []));
			for (const { to, test } of this.edges[s] ?? []) {
				edgeTo.push(to);
				switch (test.kind) {
					case 'any':
						edgeKind.push(ANY);
						edgeArg.push(0);
						break;
					case 'not-slash':
						edgeKind.push(NOT_SLASH);
						edgeArg.push(0);
						break;
					case 'code':
						edgeKind.push(CODE);
						edgeArg.push(test.code);
						break;
					case 'class':
						edgeKind.push(CLASS);
						edgeArg.push(classes.length);
						classes.push(test.takes);
						break;
				}
			}
		}
		linkStart[states] = linkTo.length;
		edgeStart[states] = edgeTo.length;
		return {
			states,
			linkStart,
			linkTo: Int32Array.from(linkTo),
			edgeStart,
			edgeTo: Int32Array.from(edgeTo),
			edgeKind: Uint8Array.from(edgeKind),
			edgeArg: Int32Array.from(edgeArg),
			classes,
			start,
			accept,
			cache: { byKey: new Map(), transitions: 0 }
		};
	}
}

/**
 * Compiles a pattern, or says why it cannot be used. Each construct gets fresh
 * states, so a loop never leaks into what comes before or after it.
 */
export function compileGlobProgram(pattern: string): Result<GlobProgram, GlobProblem> {
	const b = new Builder();
	const start = b.state();
	const accept = compileInto(b, pattern, start);
	return accept.ok ? ok(b.program(start, accept.value)) : accept;
}

/** A pattern of a union that cannot be used, and why. */
export interface UnionProblem {
	readonly pattern: string;
	readonly problem: GlobProblem;
}

/**
 * One program that matches a path when any of the patterns does: cheaper than
 * running each pattern in turn, since a path is read once.
 */
export function compileGlobUnion(patterns: readonly string[]): Result<GlobProgram, UnionProblem> {
	const b = new Builder();
	const start = b.state();
	const accept = b.state();
	for (const pattern of patterns) {
		const entry = b.state();
		b.link(start, entry);
		const end = compileInto(b, pattern, entry);
		if (!end.ok) return err({ pattern, problem: end.error });
		b.link(end.value, accept);
	}
	return ok(b.program(start, accept));
}

/** Compiles one pattern from state `from` and returns the state it accepts in. */
function compileInto(b: Builder, pattern: string, from: number): Result<number, GlobProblem> {
	if (pattern === '') return err('empty');
	if (pattern.includes('\0')) return err('nul-byte');
	// Code points, not UTF-16 units, so a character outside the BMP is one character.
	const chars = Array.from(pattern);
	if (chars.length > MAX_GLOB_LENGTH) return err('too-long');
	const rooted = chars[0] === '/';
	const body = rooted ? chars.slice(1) : chars;
	if (body.at(-1) === '/') body.push('*', '*');
	const anywhere = !rooted && !body.includes('/');
	// A pattern with no `/` may follow any folders: `(?:.*/)?`.
	const bodyStart = anywhere ? anyFolders(b, from) : from;
	const compiled = compileSequence(b, body, 0, false, bodyStart);
	return compiled.ok ? ok(compiled.value.state) : compiled;
}

/** Any number of whole folders, including none: what `**\/` matches. */
function anyFolders(b: Builder, from: number): number {
	const after = b.state();
	b.link(from, after);
	const inside = b.loop(from, anyChar);
	b.edge(inside, after, slash);
	return after;
}

interface Compiled {
	/** The state reached after what was read. */
	readonly state: number;
	/** Index just after what was read. */
	readonly end: number;
}

/**
 * Compiles `chars` from `at`, starting in state `from`. Inside braces it stops at
 * a `,` or `}` at its own level and leaves it for the caller.
 */
function compileSequence(
	b: Builder,
	chars: readonly string[],
	at: number,
	inBraces: boolean,
	from: number
): Result<Compiled, GlobProblem> {
	let state = from;
	let i = at;
	const literal = (char: string): void => {
		const next = b.state();
		b.edge(state, next, { kind: 'code', code: char.codePointAt(0) ?? 0 });
		state = next;
	};
	while (i < chars.length) {
		const c = chars[i] ?? '';
		if (inBraces && (c === ',' || c === '}')) break;
		if (c === '\\') {
			const next = chars[i + 1];
			if (next === undefined) return err('trailing-escape');
			literal(next);
			i += 2;
		} else if (c === '*') {
			let j = i;
			while (chars[j] === '*') j += 1;
			const segmentStart = i === 0 || chars[i - 1] === '/';
			const segmentEnd = j === chars.length || chars[j] === '/';
			if (j - i >= 2 && segmentStart && segmentEnd) {
				if (chars[j] === '/') {
					state = anyFolders(b, state);
					j += 1;
				} else {
					state = exitLoop(b, b.loop(state, anyChar));
				}
			} else {
				state = exitLoop(b, b.loop(state, notSlash));
			}
			i = j;
		} else if (c === '?') {
			const next = b.state();
			b.edge(state, next, notSlash);
			state = next;
			i += 1;
		} else if (c === '[') {
			const cls = characterClass(chars, i);
			if (!cls.ok) return cls;
			const next = b.state();
			b.edge(state, next, { kind: 'class', takes: cls.value.takes });
			state = next;
			i = cls.value.end;
		} else if (c === '{') {
			const after = b.state();
			let j = i + 1;
			for (;;) {
				const entry = b.state();
				b.link(state, entry);
				const part = compileSequence(b, chars, j, true, entry);
				if (!part.ok) return part;
				b.link(part.value.state, after);
				j = part.value.end;
				if (chars[j] === ',') j += 1;
				else if (chars[j] === '}') break;
				else return err('unclosed-brace');
			}
			state = after;
			i = j + 1;
		} else {
			literal(c);
			i += 1;
		}
	}
	return ok({ state, end: i });
}

/** A fresh state after a loop, so whatever follows is not inside it. */
function exitLoop(b: Builder, loop: number): number {
	const after = b.state();
	b.link(loop, after);
	return after;
}

interface Class {
	readonly takes: (code: number) => boolean;
	readonly end: number;
}

/**
 * Reads `[...]` from `open`. A `]` right after the `[` (or after `[!`) is a member,
 * a `-` between two members makes a range, and a `\` makes the next character a
 * plain member: `[\d]` is the letter d, not a digit. The class never takes `/`.
 */
function characterClass(chars: readonly string[], open: number): Result<Class, GlobProblem> {
	let i = open + 1;
	let negate = false;
	if (chars[i] === '!' || chars[i] === '^') {
		negate = true;
		i += 1;
	}
	/** Reads one member at `at`: its code point, and the index after it. */
	const member = (at: number): Result<{ code: number; end: number }, GlobProblem> => {
		const c = chars[at];
		if (c === undefined) return err('unclosed-class');
		const [char, end] = c === '\\' ? [chars[at + 1], at + 2] : [c, at + 1];
		if (char === undefined) return err('trailing-escape');
		if (char === '/') return err('slash-in-class');
		return ok({ code: char.codePointAt(0) ?? 0, end });
	};

	const ranges: { readonly low: number; readonly high: number }[] = [];
	let first = true;
	while (i < chars.length) {
		if (chars[i] === ']' && !first) {
			const inClass = (code: number): boolean =>
				ranges.some((r) => code >= r.low && code <= r.high);
			const takes = negate
				? (code: number) => code !== SLASH && !inClass(code)
				: (code: number) => code !== SLASH && inClass(code);
			return ok({ takes, end: i + 1 });
		}
		first = false;
		const low = member(i);
		if (!low.ok) return low;
		i = low.value.end;
		// A range, unless the `-` is the last character before the closing `]`.
		if (chars[i] === '-' && chars[i + 1] !== undefined && chars[i + 1] !== ']') {
			const high = member(i + 1);
			if (!high.ok) return high;
			if (high.value.code < low.value.code) return err('bad-range');
			ranges.push({ low: low.value.code, high: high.value.code });
			i = high.value.end;
		} else {
			ranges.push({ low: low.value.code, high: low.value.code });
		}
	}
	return err('unclosed-class');
}

// --- Running it ------------------------------------------------------------------

/**
 * A set of automaton states, as the matcher meets it: the states, and where each
 * character it has read from this set led. Sets are built as paths need them and
 * kept, so after the first few paths matching costs one lookup per character,
 * much as a compiled regular expression would.
 */
interface StateSet {
	/** The states, in increasing order. */
	readonly states: Int32Array;
	readonly accepting: boolean;
	/** The set each code point leads to, once worked out. */
	readonly next: Map<number, StateSet>;
}

/**
 * The sets one program has met. Bounded, so a pattern whose sets are many cannot
 * use much memory: past the bounds, sets are worked out each time and not kept,
 * which costs time within the bound but no memory.
 */
interface SetCache {
	readonly byKey: Map<string, StateSet>;
	transitions: number;
}

const MAX_CACHED_SETS = 1_000;
const MAX_CACHED_TRANSITIONS = 50_000;

/** Whether a program matches the whole of `path`, and how many steps it took to find out. */
export interface GlobRun {
	readonly matched: boolean;
	/**
	 * The work done, for checking the bound: one per character read, plus, for
	 * each set worked out, the states entered, the edges tried and the states
	 * scanned to name the set.
	 */
	readonly steps: number;
}

/** Runs a program over a path, keeping every state it could be in at once. */
export function runGlobProgram(program: GlobProgram, path: string): GlobRun {
	const { states, linkStart, linkTo, edgeStart, edgeTo, edgeKind, edgeArg, classes } = program;
	const { cache } = program;
	const marked = new Uint8Array(states);
	const stack = new Int32Array(states + linkTo.length + 1);
	let steps = 0;

	/** Marks `state` and every state its empty links reach. */
	const enter = (state: number): void => {
		let top = 0;
		stack[top++] = state;
		while (top > 0) {
			const s = stack[--top] ?? 0;
			if (marked[s] === 1) continue;
			marked[s] = 1;
			steps += 1;
			const end = linkStart[s + 1] ?? 0;
			for (let l = linkStart[s] ?? 0; l < end; l += 1) {
				const t = linkTo[l] ?? 0;
				if (marked[t] === 0) stack[top++] = t;
			}
		}
	};

	/** The set of the marked states, which it clears, from the cache when it is there. */
	const markedSet = (): StateSet => {
		const members: number[] = [];
		for (let s = 0; s < states; s += 1) {
			if (marked[s] === 1) {
				members.push(s);
				marked[s] = 0;
			}
		}
		steps += states;
		const key = members.join(',');
		const known = cache.byKey.get(key);
		if (known !== undefined) return known;
		const set: StateSet = {
			states: Int32Array.from(members),
			accepting: members.includes(program.accept),
			next: new Map()
		};
		if (cache.byKey.size < MAX_CACHED_SETS) cache.byKey.set(key, set);
		return set;
	};

	/** The set reached from `from` by reading `code`. */
	const advance = (from: StateSet, code: number): StateSet => {
		for (const s of from.states) {
			const end = edgeStart[s + 1] ?? 0;
			for (let e = edgeStart[s] ?? 0; e < end; e += 1) {
				steps += 1;
				const arg = edgeArg[e] ?? 0;
				const kind = edgeKind[e];
				const takes =
					kind === ANY ||
					(kind === NOT_SLASH && code !== SLASH) ||
					(kind === CODE && code === arg) ||
					(kind === CLASS && (classes[arg]?.(code) ?? false));
				if (takes) enter(edgeTo[e] ?? 0);
			}
		}
		const to = markedSet();
		if (cache.transitions < MAX_CACHED_TRANSITIONS) {
			from.next.set(code, to);
			cache.transitions += 1;
		}
		return to;
	};

	enter(program.start);
	let set = markedSet();
	for (const char of path) {
		const code = char.codePointAt(0) ?? 0;
		steps += 1;
		set = set.next.get(code) ?? advance(set, code);
		if (set.states.length === 0) return { matched: false, steps };
	}
	return { matched: set.accepting, steps };
}

/** The most steps `runGlobProgram` can take for this program on a path of `length` code points. */
export function globStepBound(program: GlobProgram, length: number): number {
	return (length + 1) * (2 * program.states + program.edgeTo.length + 1);
}
