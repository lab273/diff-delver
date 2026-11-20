/**
 * Reads the file listing from `git diff-tree -z --raw` output: the authoritative
 * statuses, paths, modes, blob ids and similarity of every changed file.
 *
 * The listing is NUL-separated, so paths are given exactly, whatever characters
 * they contain. A record is `:<old mode> <new mode> <old blob> <new blob> <status>`
 * then one path, or two (source, then destination) for a rename or copy.
 */
import { parseBlobId, type BlobId } from '../blob-id.tiny.ts';
import { parseFileMode, type FileMode } from '../file-mode.tiny.ts';
import { parseGitStatusLetter, type FileStatus } from '../file-status.tiny.ts';
import { isNullObjectId } from '../object-id.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import { parseSimilarity, type Similarity } from '../similarity.tiny.ts';
import type { DiffOutputError } from './diff-output-error.ts';

export interface RawSide {
	readonly path: RepoPath;
	readonly mode: FileMode;
	/** Absent when git gives the all-zero id: the file does not exist on this side. */
	readonly blob: BlobId | undefined;
}

export interface RawEntry {
	readonly status: FileStatus;
	readonly similarity: Similarity | undefined;
	readonly old: RawSide;
	readonly new: RawSide;
}

export interface RawListing {
	readonly entries: readonly RawEntry[];
	/** The rest of the output: the patch text that follows the listing. */
	readonly patch: string;
}

const META = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMRCT])([0-9]{0,3})$/;

/** Splits `--patch-with-raw -z` output into its listing and its patch text. */
export function parseRawListing(output: string): Result<RawListing, DiffOutputError> {
	const entries: RawEntry[] = [];
	let at = 0;
	const fail = (detail: string): Result<never, DiffOutputError> =>
		err({ kind: 'MalformedRawListing', offset: at, detail });

	const field = (): string | undefined => {
		const end = output.indexOf('\0', at);
		if (end === -1) return undefined;
		const value = output.slice(at, end);
		at = end + 1;
		return value;
	};

	while (output.startsWith(':', at)) {
		const meta = field();
		const match = meta === undefined ? null : META.exec(meta);
		if (match === null) return fail(`unreadable record ${JSON.stringify(meta)}`);
		const [, oldMode, newMode, oldBlob, newBlob, letter, score] = match;
		const twoPaths = letter === 'R' || letter === 'C';
		const firstPath = field();
		const secondPath = twoPaths ? field() : firstPath;
		if (firstPath === undefined || secondPath === undefined) return fail('missing path');

		const status = parseGitStatusLetter(letter ?? '');
		const sides = [
			side(firstPath, oldMode ?? '', oldBlob ?? ''),
			side(secondPath, newMode ?? '', newBlob ?? '')
		] as const;
		const similarity =
			score === undefined || score === '' ? undefined : parseSimilarity(Number(score));
		if (!status.ok) return fail(`unknown status ${letter ?? ''}`);
		if (!sides[0].ok) return fail(sides[0].error);
		if (!sides[1].ok) return fail(sides[1].error);
		if (similarity !== undefined && !similarity.ok) return fail(`bad similarity ${score ?? ''}`);
		entries.push({
			status: status.value,
			similarity: similarity?.value,
			old: sides[0].value,
			new: sides[1].value
		});
	}

	if (at === output.length) return ok({ entries, patch: '' });
	// The listing ends with an empty record before the patch text.
	if (output[at] !== '\0') return fail('expected the end of the listing');
	return ok({ entries, patch: output.slice(at + 1) });
}

function side(path: string, mode: string, blob: string): Result<RawSide, string> {
	const parsedPath = parseRepoPath(path);
	if (!parsedPath.ok) return err(`bad path ${JSON.stringify(path)} (${parsedPath.error.reason})`);
	const parsedMode = parseFileMode(mode);
	if (!parsedMode.ok) return err(`bad mode ${mode}`);
	if (isNullObjectId(blob))
		return ok({ path: parsedPath.value, mode: parsedMode.value, blob: undefined });
	const parsedBlob = parseBlobId(blob);
	if (!parsedBlob.ok) return err(`bad object id ${blob}`);
	return ok({ path: parsedPath.value, mode: parsedMode.value, blob: parsedBlob.value });
}
