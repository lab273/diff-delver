/**
 * Which build of diff delver this is (`CodeVersion`). The command's build
 * (`vite.cli.config.ts`) writes it in as `__DIFF_DELVER_VERSION__`: the release
 * (or the package version marked `-dev`) and a hash of the code. Run from
 * source, as tests do, it is the package version marked `-dev+source`.
 */
import { z } from 'zod';
import type { BuildCommit, BuildIdentity } from '#lib/core/build-identity.ts';
import { parseCodeVersion, type CodeVersion } from '#lib/core/code-version.tiny.ts';
import { parseCommitId } from '#lib/core/commit-id.tiny.ts';
import { releaseOfCodeVersion } from '#lib/core/release-version.tiny.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';

/** The package version, which the command's build also writes in. */
const PACKAGE_VERSION = '0.0.1';

export function codeVersion(): CodeVersion {
	const built = typeof __DIFF_DELVER_VERSION__ === 'string' ? __DIFF_DELVER_VERSION__ : undefined;
	const parsed = parseCodeVersion(built ?? `${PACKAGE_VERSION}-dev+source`);
	if (!parsed.ok)
		throw new Error(`The build wrote in a version that is not one: ${parsed.error.value}`);
	return parsed.value;
}

const RecordedCommit = z.object({
	commit: z.string(),
	committedAt: z.number().nullable(),
	changes: z.boolean()
});

/**
 * The commit the command's build was made from, as it wrote it in as
 * `__DIFF_DELVER_COMMIT__`; undefined when it knew none, or run from source.
 */
function buildCommit(): BuildCommit | undefined {
	const recorded = RecordedCommit.safeParse(
		typeof __DIFF_DELVER_COMMIT__ === 'undefined' ? null : __DIFF_DELVER_COMMIT__
	);
	if (!recorded.success) return undefined;
	const commit = parseCommitId(recorded.data.commit);
	if (!commit.ok) return undefined;
	const committedAt =
		recorded.data.committedAt === null ? undefined : parseTimestamp(recorded.data.committedAt);
	return {
		commit: commit.value,
		committedAt: committedAt?.ok === true ? committedAt.value : undefined,
		changes: recorded.data.changes
	};
}

/** Which build this is, for the header of every page: its release, if any, and its commit. */
export function buildIdentity(): BuildIdentity {
	return { release: releaseOfCodeVersion(codeVersion()), commit: buildCommit() };
}
