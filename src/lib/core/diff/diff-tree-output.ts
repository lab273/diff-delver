/**
 * Turns the output of one `git diff-tree -r -z --patch-with-raw` run into the
 * model's `FileDiff` list.
 *
 * The raw listing is the authority for which files changed and how. The patch
 * sections follow it in the same order, one per listed file, except that git
 * writes a type change (a file becoming a symlink, say) as two sections: the old
 * file deleted, then the new one added. The two are joined by position, and both
 * the count and the kind of every section are checked against the listing.
 */
import { fileModeKind } from '../file-mode.tiny.ts';
import { hunkIdAt } from '../hunk-id.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import type { DiffOutputError } from './diff-output-error.ts';
import type { FileContent, FileDiff, FileVersion } from './file-diff.ts';
import { parsePatch, type PatchSection } from './patch.ts';
import { parseRawListing, type RawEntry, type RawSide } from './raw-listing.ts';

/** Reads `git diff-tree -r -z --patch-with-raw` output. */
export function parseDiffTreeOutput(output: string): Result<readonly FileDiff[], DiffOutputError> {
	const listing = parseRawListing(output);
	if (!listing.ok) return listing;
	const sections = parsePatch(listing.value.patch);
	if (!sections.ok) return sections;
	return joinListingAndPatch(listing.value.entries, sections.value);
}

function patchesFor(entry: RawEntry): number {
	return entry.status === 'type-changed' ? 2 : 1;
}

/** Joins the listing and the patch sections by position, checking that they agree. */
export function joinListingAndPatch(
	entries: readonly RawEntry[],
	sections: readonly PatchSection[]
): Result<readonly FileDiff[], DiffOutputError> {
	const expected = entries.reduce((sum, entry) => sum + patchesFor(entry), 0);
	if (expected !== sections.length) {
		return err({
			kind: 'PatchCountMismatch',
			listedFiles: entries.length,
			expectedPatches: expected,
			foundPatches: sections.length
		});
	}

	const files: FileDiff[] = [];
	let next = 0;
	for (const entry of entries) {
		const own = sections.slice(next, next + patchesFor(entry));
		next += own.length;
		const file = toFileDiff(entry, own);
		if (!file.ok) return file;
		files.push(file.value);
	}
	return ok(files);
}

function toFileDiff(
	entry: RawEntry,
	sections: readonly PatchSection[]
): Result<FileDiff, DiffOutputError> {
	const path = entry.status === 'deleted' ? entry.old.path : entry.new.path;
	const mismatch = (detail: string): Result<never, DiffOutputError> =>
		err({ kind: 'PatchMismatch', path, status: entry.status, detail });

	const problem = checkSections(entry, sections);
	if (problem !== undefined) return mismatch(problem);

	const old = entry.status === 'added' ? undefined : version(entry.old);
	const now = entry.status === 'deleted' ? undefined : version(entry.new);
	if (old === null || now === null) return mismatch('a side that exists has no object id');

	return ok({
		path,
		status: entry.status,
		old,
		new: now,
		similarity: entry.similarity,
		content: content(entry, sections)
	});
}

function version(side: RawSide): FileVersion | null {
	return side.blob === undefined ? null : { path: side.path, mode: side.mode, blob: side.blob };
}

/** What is wrong with a file's patch sections given its status, if anything. */
function checkSections(entry: RawEntry, sections: readonly PatchSection[]): string | undefined {
	const [first, second] = sections;
	if (first === undefined) return 'no patch';
	const plain = (s: PatchSection): boolean =>
		!s.newFile && !s.deletedFile && !s.renamed && !s.copied;
	switch (entry.status) {
		case 'added':
			return first.newFile ? undefined : 'the patch does not add a file';
		case 'deleted':
			return first.deletedFile ? undefined : 'the patch does not delete a file';
		case 'renamed':
			return first.renamed ? undefined : 'the patch does not rename a file';
		case 'copied':
			return first.copied ? undefined : 'the patch does not copy a file';
		case 'modified':
			return plain(first) ? undefined : 'the patch adds, deletes, renames or copies a file';
		case 'type-changed':
			return first.deletedFile && second?.newFile === true
				? undefined
				: 'the patches do not delete the old file and add the new one';
	}
}

function content(entry: RawEntry, sections: readonly PatchSection[]): FileContent {
	if (
		fileModeKind(entry.old.mode) === 'submodule' ||
		fileModeKind(entry.new.mode) === 'submodule'
	) {
		return { kind: 'submodule' };
	}
	if (sections.some((section) => section.binary)) return { kind: 'binary' };
	const hunks = sections.flatMap((section) => section.hunks);
	return { kind: 'text', hunks: hunks.map((hunk, index) => ({ id: hunkIdAt(index), ...hunk })) };
}
