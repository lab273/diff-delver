/**
 * Diffs between modelled trees, for the carry-over's tests (DESIGN 6.2): a tree
 * is a map from path to the lines of a text file, and `treeDiff` gives what the
 * one fixed diff command would give for two of them, as `diff-tree` output read
 * by the real parser. Lines are compared with Myers' algorithm and grouped into
 * hunks with three lines of context, as git groups them. Renames and copies are
 * named by the test, since git's similarity guess is not what is being tested.
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

export interface TreeDiffOptions {
	/** Files the later tree renamed: earlier path to later path. */
	readonly renames?: Readonly<Record<string, string>>;
	/** Files the later tree copied: earlier path to the copy's path. */
	readonly copies?: Readonly<Record<string, string>>;
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
const MODE = '100644';

interface Entry {
	readonly sortKey: string;
	readonly raw: string;
	readonly patch: string;
}

function entry(
	status: 'A' | 'D' | 'M' | 'R' | 'C',
	oldPath: string | undefined,
	newPath: string | undefined,
	a: readonly string[],
	b: readonly string[]
): Entry {
	const oldBlob = oldPath === undefined ? NONE : blobOf(a);
	const newBlob = newPath === undefined ? NONE : blobOf(b);
	const oldMode = oldPath === undefined ? '000000' : MODE;
	const newMode = newPath === undefined ? '000000' : MODE;
	const shownOld = oldPath ?? newPath ?? '';
	const shownNew = newPath ?? oldPath ?? '';
	const paths =
		status === 'R' || status === 'C' ? `${shownOld}\0${shownNew}\0` : `${newPath ?? shownOld}\0`;
	const score = status === 'R' || status === 'C' ? `${status}090` : status;
	const raw = `:${oldMode} ${newMode} ${oldBlob} ${newBlob} ${score}\0${paths}`;
	const hunks = hunksText(a, b);
	const header = [`diff --git a/${shownOld} b/${shownNew}\n`];
	switch (status) {
		case 'A':
			header.push(`new file mode ${MODE}\n`, `index ${NONE}..${newBlob}\n`);
			if (hunks !== '') header.push('--- /dev/null\n', `+++ b/${shownNew}\n`);
			break;
		case 'D':
			header.push(`deleted file mode ${MODE}\n`, `index ${oldBlob}..${NONE}\n`);
			if (hunks !== '') header.push(`--- a/${shownOld}\n`, '+++ /dev/null\n');
			break;
		case 'M':
			header.push(`index ${oldBlob}..${newBlob} ${MODE}\n`);
			if (hunks !== '') header.push(`--- a/${shownOld}\n`, `+++ b/${shownNew}\n`);
			break;
		case 'R':
		case 'C': {
			const word = status === 'R' ? 'rename' : 'copy';
			header.push(
				'similarity index 90%\n',
				`${word} from ${shownOld}\n`,
				`${word} to ${shownNew}\n`
			);
			if (hunks !== '') {
				header.push(`index ${oldBlob}..${newBlob} ${MODE}\n`);
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

/** What the fixed diff command gives between two trees. */
export function treeDiffOutput(from: Tree, to: Tree, options: TreeDiffOptions = {}): Uint8Array {
	const renames = new Map(Object.entries(options.renames ?? {}));
	const copies = new Map(Object.entries(options.copies ?? {}));
	const renamedTo = new Set(renames.values());
	const copiedTo = new Set(copies.values());
	const entries: Entry[] = [];
	for (const [path, lines] of from) {
		const renamed = renames.get(path);
		if (renamed !== undefined) {
			entries.push(entry('R', path, renamed, lines, to.get(renamed) ?? []));
			continue;
		}
		const later = to.get(path);
		if (later === undefined) entries.push(entry('D', path, undefined, lines, []));
		else if (!same(lines, later)) entries.push(entry('M', path, path, lines, later));
	}
	for (const [source, copy] of copies) {
		entries.push(entry('C', source, copy, from.get(source) ?? [], to.get(copy) ?? []));
	}
	for (const [path, lines] of to) {
		if (from.has(path) || renamedTo.has(path) || copiedTo.has(path)) continue;
		entries.push(entry('A', undefined, path, [], lines));
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
