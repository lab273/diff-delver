/**
 * An update at the size the design promises, for the carry-over's size tests:
 * `fileCount` files of `hunks` hunks each, every hunk a run of 25 deleted and 25
 * added lines between context, so 100 changed lines a file at two hunks. The
 * new version adds one line at the top of every file, which moves every other
 * line down by one, and git's diff between the two heads says so; everything
 * else is the same, so every old change line is looked up and matched.
 *
 * A fifth of the files sit in a section, the rest are not sorted yet, and half
 * the files are marked reviewed.
 *
 * Pure: no Node imports, no clock and no randomness.
 */
import { describeDiffOutputError } from '#lib/core/diff/diff-output-error.ts';
import { parseDiffTreeOutput } from '#lib/core/diff/diff-tree-output.ts';
import { assign } from '#lib/core/diff/assign.ts';
import { makeDiff, type Diff } from '#lib/core/diff/diff.ts';
import type { FileDiff } from '#lib/core/diff/file-diff.ts';
import { initialState } from '#lib/core/diff/state.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { FileReviewed } from '#lib/core/review/reviewed-marks.ts';
import type { CarryOverInput } from '#lib/core/update/carry-over.ts';
import { NO_TREE_CHANGES } from '#lib/core/update/line-map.ts';

const RUN = 25;

function blob(file: number, version: number): string {
	return `${String(version)}${String(file).padStart(39, '0')}`;
}

function pathOf(file: number): string {
	return `src/module-${String(file).padStart(5, '0')}/file.ts`;
}

/** One hunk's text: context, a run deleted, its replacement added, context. */
function hunk(oldStart: number, newStart: number, at: number): string {
	const lines = [
		`@@ -${String(oldStart)},${String(RUN + 2)} +${String(newStart)},${String(RUN + 2)} @@\n`
	];
	lines.push(` context ${String(at)}\n`);
	for (let i = 0; i < RUN; i += 1) lines.push(`-old ${String(at)} ${String(i)}\n`);
	for (let i = 0; i < RUN; i += 1) lines.push(`+new ${String(at)} ${String(i)}\n`);
	lines.push(` context ${String(at + 1)}\n`);
	return lines.join('');
}

function output(
	fileCount: number,
	describe: (file: number) => {
		readonly oldBlob: string;
		readonly newBlob: string;
		readonly hunks: string;
	}
): Uint8Array {
	const raw: string[] = [];
	const patches: string[] = [];
	for (let file = 0; file < fileCount; file += 1) {
		const path = pathOf(file);
		const { oldBlob, newBlob, hunks } = describe(file);
		raw.push(`:100644 100644 ${oldBlob} ${newBlob} M\0${path}\0`);
		patches.push(
			`diff --git a/${path} b/${path}\nindex ${oldBlob}..${newBlob} 100644\n--- a/${path}\n+++ b/${path}\n${hunks}`
		);
	}
	return new TextEncoder().encode(`${raw.join('')}\0${patches.join('')}`);
}

function files(bytes: Uint8Array): readonly FileDiff[] {
	const parsed = parseDiffTreeOutput(bytes);
	if (!parsed.ok) throw new Error(describeDiffOutputError(parsed.error));
	return parsed.value;
}

function diffOf(bytes: Uint8Array): Diff {
	const diff = makeDiff(files(bytes));
	if (!diff.ok) throw new Error('duplicate path');
	return diff.value;
}

/** Where each hunk of a file starts on the old side. */
function starts(hunks: number): readonly number[] {
	return Array.from({ length: hunks }, (_, j) => 10 + j * (RUN + 2 + 30));
}

/** The previous version, the new diff and the heads' diff, ready for `carryOver`. */
export function updateAtScale(fileCount: number, hunks = 2): CarryOverInput {
	const before = diffOf(
		output(fileCount, (file) => ({
			oldBlob: blob(file, 1),
			newBlob: blob(file, 2),
			hunks: starts(hunks)
				.map((s, j) => hunk(s, s, j * 2))
				.join('')
		}))
	);
	const after = diffOf(
		output(fileCount, (file) => ({
			oldBlob: blob(file, 1),
			newBlob: blob(file, 3),
			hunks: `@@ -0,0 +1 @@\n+top\n${starts(hunks)
				.map((s, j) => hunk(s, s + 1, j * 2))
				.join('')}`
		}))
	);
	const heads = files(
		output(fileCount, (file) => ({
			oldBlob: blob(file, 2),
			newBlob: blob(file, 3),
			hunks: '@@ -0,0 +1 @@\n+top\n'
		}))
	);
	const fifth = Math.max(1, Math.floor(fileCount / 5));
	const state = assign(
		before,
		initialState(before),
		Array.from({ length: fifth }, (_, i) => ({ file: pathOf(i), section: 'first' }))
	).state;
	const marked = new Map<RepoPath, FileReviewed>();
	for (const [i, file] of before.files.entries()) {
		if (i % 2 === 0) {
			marked.set(file.file.path, { old: file.changed.old, new: file.changed.new, file: false });
		}
	}
	return {
		previous: { diff: before, state, marks: { files: marked } },
		diff: after,
		heads: { kind: 'diff', files: heads },
		bases: NO_TREE_CHANGES
	};
}
