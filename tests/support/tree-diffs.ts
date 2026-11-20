/**
 * Diffs between modelled trees, for the carry-over's tests (DESIGN 6.2): a tree
 * is a map from path to the lines of a text file, and `treeDiff` gives what the
 * one fixed diff command would give for two of them, as `diff-tree` output read
 * by the real parser. Lines are compared with Myers' algorithm and grouped into
 * hunks with three lines of context, as git groups them. Renames and copies are
 * named by the test, since git's similarity guess is not what is being tested,
 * and so are modes: a file is a plain file unless the test makes it executable
 * or a link, whose one line is its target.
 *
 * Pure: no Node imports, no clock and no randomness, so core tests can use it.
 */
import { describeDiffOutputError } from '#lib/core/diff/diff-output-error.ts';
import { parseDiffTreeOutput } from '#lib/core/diff/diff-tree-output.ts';
import { makeDiff, type Diff } from '#lib/core/diff/diff.ts';
import type { FileDiff } from '#lib/core/diff/file-diff.ts';

/** A tree: each text file's lines, by path. */
export type Tree = ReadonlyMap<string, readonly string[]>;

export function tree(files: Record<string, readonly string[]>): Tree {
	return new Map(Object.entries(files));
}

/** A file's mode in a tree: a plain file, an executable one, or a link. */
export type TreeMode = '100644' | '100755' | '120000';

/** Each file's mode, by path, where it is not a plain file. */
export type TreeModes = Readonly<Record<string, TreeMode>>;

export interface TreeDiffOptions {
	/** Files the later tree renamed: earlier path to later path. */
	readonly renames?: Readonly<Record<string, string>>;
	/** Files the later tree copied: earlier path to the copy's path. */
	readonly copies?: Readonly<Record<string, string>>;
	/** The modes of the earlier and the later tree's files that are not plain files. */
	readonly modes?: { readonly from?: TreeModes; readonly to?: TreeModes };
}

type Op = '=' | '-' | '+';

/**
 * The shortest edit script from `a` to `b` (Myers, 1986): O((N + M) D) time,
 * where D is the number of lines that differ.
 */
export function editScript(a: readonly string[], b: readonly string[]): readonly Op[] {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = -1;
	for (let d = 0; d <= max && found < 0; d += 1) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
			let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x += 1;
				y += 1;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
	}
	const ops: Op[] = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d -= 1) {
		const previous = trace[d];
		if (previous === undefined) throw new Error('The trace is shorter than the script.');
		const k = x - y;
		const down =
			k === -d || (k !== d && (previous[offset + k - 1] ?? 0) < (previous[offset + k + 1] ?? 0));
		const priorK = down ? k + 1 : k - 1;
		const priorX = previous[offset + priorK] ?? 0;
		const priorY = priorX - priorK;
		while (x > priorX && y > priorY) {
			ops.push('=');
			x -= 1;
			y -= 1;
		}
		ops.push(down ? '+' : '-');
		x = priorX;
		y = priorY;
	}
	while (x > 0 && y > 0) {
		ops.push('=');
		x -= 1;
		y -= 1;
	}
	return ops.reverse();
}

const CONTEXT = 3;

interface Line {
	readonly op: Op;
	readonly text: string;
	readonly old: number;
	readonly new: number;
}

function hunksText(a: readonly string[], b: readonly string[]): string {
	const lines: Line[] = [];
	let i = 0;
	let j = 0;
	for (const op of editScript(a, b)) {
		switch (op) {
			case '=':
				lines.push({ op, text: a[i] ?? '', old: i + 1, new: j + 1 });
				i += 1;
				j += 1;
				break;
			case '-':
				lines.push({ op, text: a[i] ?? '', old: i + 1, new: j });
				i += 1;
				break;
			case '+':
				lines.push({ op, text: b[j] ?? '', old: i, new: j + 1 });
				j += 1;
				break;
		}
	}
	const changed = lines.flatMap((line, index) => (line.op === '=' ? [] : [index]));
	const groups: { first: number; last: number }[] = [];
	for (const index of changed) {
		const group = groups.at(-1);
		// git joins two changes whose context would meet: at most twice the context between them.
		if (group !== undefined && index - group.last - 1 <= 2 * CONTEXT) group.last = index;
		else groups.push({ first: index, last: index });
	}
	const out: string[] = [];
	for (const group of groups) {
		const from = Math.max(0, group.first - CONTEXT);
		const to = Math.min(lines.length - 1, group.last + CONTEXT);
		const shown = lines.slice(from, to + 1);
		const oldLines = shown.filter((l) => l.op !== '+');
		const newLines = shown.filter((l) => l.op !== '-');
		const oldStart = oldLines[0]?.old ?? shown[0]?.old ?? 0;
		const newStart = newLines[0]?.new ?? shown[0]?.new ?? 0;
		const span = (start: number, length: number): string =>
			length === 1 ? String(start) : `${String(start)},${String(length)}`;
		out.push(
			`@@ -${span(oldLines.length === 0 ? (shown[0]?.old ?? 0) : oldStart, oldLines.length)} +${span(newLines.length === 0 ? (shown[0]?.new ?? 0) : newStart, newLines.length)} @@\n`
		);
		for (const line of shown) out.push(`${line.op === '=' ? ' ' : line.op}${line.text}\n`);
	}
	return out.join('');
}

/** A made-up object id for some lines, the same for the same lines. */
function blobOf(lines: readonly string[]): string {
	const text = lines.join('\n');
	let hex = '';
	for (let seed = 0; hex.length < 40; seed += 1) {
		let h = 0x811c9dc5 ^ seed;
		for (let i = 0; i < text.length; i += 1) {
			h ^= text.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		hex += (h >>> 0).toString(16).padStart(8, '0');
	}
	return `1${hex.slice(1, 40)}`;
}

const NONE = '0'.repeat(40);
const PLAIN: TreeMode = '100644';
const LINK: TreeMode = '120000';

interface Entry {
	readonly sortKey: string;
	readonly raw: string;
	readonly patch: string;
}

/** One side of a file in an entry: its path, lines and mode, or nothing. */
interface Side {
	readonly path: string;
	readonly lines: readonly string[];
	readonly mode: TreeMode;
}

/** The patch text of a file added or deleted whole, as git writes it. */
function wholeFile(kind: 'new' | 'deleted', side: Side, blob: string): string {
	const out = [`diff --git a/${side.path} b/${side.path}\n`, `${kind} file mode ${side.mode}\n`];
	const hunks = kind === 'new' ? hunksText([], side.lines) : hunksText(side.lines, []);
	out.push(kind === 'new' ? `index ${NONE}..${blob}\n` : `index ${blob}..${NONE}\n`);
	if (hunks !== '') {
		out.push(
			kind === 'new' ? '--- /dev/null\n' : `--- a/${side.path}\n`,
			kind === 'new' ? `+++ b/${side.path}\n` : '+++ /dev/null\n',
			hunks
		);
		// A link's target has no newline after it.
		if (side.mode === LINK) out.push('\\ No newline at end of file\n');
	}
	return out.join('');
}

function entry(
	status: 'A' | 'D' | 'M' | 'R' | 'C' | 'T',
	old: Side | undefined,
	now: Side | undefined
): Entry {
	const oldBlob = old === undefined ? NONE : blobOf(old.lines);
	const newBlob = now === undefined ? NONE : blobOf(now.lines);
	const oldMode = old?.mode ?? '000000';
	const newMode = now?.mode ?? '000000';
	const shownOld = old?.path ?? now?.path ?? '';
	const shownNew = now?.path ?? old?.path ?? '';
	const paths = status === 'R' || status === 'C' ? `${shownOld}\0${shownNew}\0` : `${shownNew}\0`;
	const score = status === 'R' || status === 'C' ? `${status}090` : status;
	const raw = `:${oldMode} ${newMode} ${oldBlob} ${newBlob} ${score}\0${paths}`;
	const a = old?.lines ?? [];
	const b = now?.lines ?? [];
	const hunks = hunksText(a, b);
	const header = [`diff --git a/${shownOld} b/${shownNew}\n`];
	const modeChanged = old !== undefined && now !== undefined && old.mode !== now.mode;
	const modes = modeChanged ? [`old mode ${oldMode}\n`, `new mode ${newMode}\n`] : [];
	const index = `index ${oldBlob}..${newBlob}${modeChanged ? '' : ` ${newMode}`}\n`;
	switch (status) {
		case 'A':
		case 'D':
		case 'T': {
			// A change of kind is a deletion and an addition in git's patch.
			const parts: string[] = [];
			if (old !== undefined) parts.push(wholeFile('deleted', old, oldBlob));
			if (now !== undefined) parts.push(wholeFile('new', now, newBlob));
			return { sortKey: shownNew, raw, patch: parts.join('') };
		}
		case 'M':
			header.push(...modes);
			if (hunks !== '' || !modeChanged) header.push(index);
			if (hunks !== '') header.push(`--- a/${shownOld}\n`, `+++ b/${shownNew}\n`);
			break;
		case 'R':
		case 'C': {
			const word = status === 'R' ? 'rename' : 'copy';
			header.push(
				...modes,
				'similarity index 90%\n',
				`${word} from ${shownOld}\n`,
				`${word} to ${shownNew}\n`
			);
			if (hunks !== '') {
				header.push(index);
				header.push(`--- a/${shownOld}\n`, `+++ b/${shownNew}\n`);
			}
			break;
		}
	}
	return { sortKey: shownNew, raw, patch: header.join('') + hunks };
}

function same(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** Whether a mode is a link's, as against a file's. */
function isLink(mode: TreeMode): boolean {
	return mode === LINK;
}

/** What the fixed diff command gives between two trees. */
export function treeDiffOutput(from: Tree, to: Tree, options: TreeDiffOptions = {}): Uint8Array {
	const renames = new Map(Object.entries(options.renames ?? {}));
	const copies = new Map(Object.entries(options.copies ?? {}));
	const renamedTo = new Set(renames.values());
	const copiedTo = new Set(copies.values());
	const fromModes = options.modes?.from ?? {};
	const toModes = options.modes?.to ?? {};
	const side = (tree: Tree, modes: TreeModes, path: string): Side | undefined => {
		const lines = tree.get(path);
		return lines === undefined ? undefined : { path, lines, mode: modes[path] ?? PLAIN };
	};
	const entries: Entry[] = [];
	for (const path of from.keys()) {
		const old = side(from, fromModes, path);
		if (old === undefined) continue;
		const renamed = renames.get(path);
		if (renamed !== undefined) {
			entries.push(entry('R', old, side(to, toModes, renamed)));
			continue;
		}
		const later = side(to, toModes, path);
		if (later === undefined) entries.push(entry('D', old, undefined));
		else if (isLink(old.mode) !== isLink(later.mode)) entries.push(entry('T', old, later));
		else if (!same(old.lines, later.lines) || old.mode !== later.mode) {
			entries.push(entry('M', old, later));
		}
	}
	for (const [source, copy] of copies) {
		entries.push(entry('C', side(from, fromModes, source), side(to, toModes, copy)));
	}
	for (const path of to.keys()) {
		if (from.has(path) || renamedTo.has(path) || copiedTo.has(path)) continue;
		entries.push(entry('A', undefined, side(to, toModes, path)));
	}
	entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
	if (entries.length === 0) return new Uint8Array();
	const text = `${entries.map((e) => e.raw).join('')}\0${entries.map((e) => e.patch).join('')}`;
	return new TextEncoder().encode(text);
}

/** The files of the diff between two trees, as the parser reads them. */
export function treeDiff(from: Tree, to: Tree, options: TreeDiffOptions = {}): readonly FileDiff[] {
	const parsed = parseDiffTreeOutput(treeDiffOutput(from, to, options));
	if (!parsed.ok) throw new Error(describeDiffOutputError(parsed.error));
	return parsed.value;
}

/** The diff model of the diff between two trees. */
export function diffOf(from: Tree, to: Tree, options: TreeDiffOptions = {}): Diff {
	const diff = makeDiff(treeDiff(from, to, options));
	if (!diff.ok) throw new Error(`Duplicate path ${diff.error.path}`);
	return diff.value;
}
