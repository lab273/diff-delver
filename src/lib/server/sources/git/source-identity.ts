/**
 * A cheap fingerprint of a source's current state (DESIGN 6.2): would a snapshot
 * taken now differ from the last one? Good enough to drive a "this diff has
 * changed" banner; the update itself compares the new snapshot's trees.
 *
 * - A commit or a range: the commits its revisions name now. Exact, and one or
 *   two `rev-parse` calls (a few milliseconds).
 * - Staged: HEAD and every entry of the index (mode, object, stage, path), from
 *   `git ls-files --stage`. Exact; it reads the whole index, which is
 *   milliseconds even for a large repository.
 * - Working tree: HEAD, git's status of the working tree (as `git status`
 *   computes it from the index's cached file stats, so unchanged files are not
 *   read), and the size, times and inode of every file it lists, plus the
 *   checked-out commit of any submodule or nested repository it lists. About as
 *   costly as `git status`, which is tens of milliseconds for thousands of files.
 *
 * When the working-tree fingerprint can be wrong:
 *
 * - It can say "changed" when a snapshot would be the same: a listed file
 *   touched but not edited, or changes staged or unstaged, which moves them
 *   between the index and the working tree but not the result.
 * - It can miss a change that git's own status misses: a file edited without its
 *   size or times changing (within the file system's timestamp resolution), a
 *   change to the reviewer's global or system ignore rules, line-ending settings
 *   or filters, or a clean or smudge filter that starts giving other output.
 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import type { GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { parseSourceIdentity, type SourceIdentity } from '#lib/core/source-identity.tiny.ts';
import type { GitSourceError } from './git-source-error.ts';
import { gitIn, sharedIndexFiles, type LocalRepository } from './local-repository.ts';
import { headCommit, resolveCommit } from './resolve.ts';
import { withScratchIndex } from './scratch-index.ts';
import { entryOnDisk, workingTreeStatus, type WorkingTreeStatus } from './working-tree-status.ts';

function fingerprint(parts: readonly (string | Buffer)[]): SourceIdentity {
	const hash = createHash('sha256');
	for (const part of parts) {
		hash.update(part);
		hash.update('\0');
	}
	const identity = parseSourceIdentity(hash.digest('hex'));
	if (!identity.ok) throw new Error('A SHA-256 digest is a source identity');
	return identity.value;
}

/** Every index entry with its object id and stage, without the cached stats. */
async function indexEntries(repo: LocalRepository): Promise<Result<Buffer, GitSourceError>> {
	const run = (index: string | undefined) =>
		gitIn(
			repo,
			repo.workTree ?? repo.gitDir,
			['-c', 'core.fsmonitor=false', 'ls-files', '--stage', '--sparse', '-z'],
			{
				env: { GIT_NO_LAZY_FETCH: '1', ...(index === undefined ? {} : { GIT_INDEX_FILE: index }) }
			}
		);
	const listed =
		(await sharedIndexFiles(repo)).length === 0
			? await run(undefined)
			: await withScratchIndex(repo, undefined, (scratch) => run(scratch.index));
	return listed.ok ? ok(listed.value.stdout) : listed;
}

/** What each listed file is on disk now, and where listed submodules point. */
async function onDisk(
	repo: LocalRepository,
	status: WorkingTreeStatus
): Promise<readonly string[]> {
	return Promise.all(
		status.entries.map(async (entry) => {
			const at = entryOnDisk(repo, entry);
			// For a submodule or a nested repository only its checked-out commit is snapshotted.
			const nested =
				entry.submoduleMoved || (entry.kind === 'untracked' && entry.path.at(-1) === 0x2f);
			if (nested) {
				const dir = parseAbsolutePath(at.toString('utf8'));
				const head = dir.ok
					? await gitIn(repo, dir.value, ['rev-parse', '--verify', '--quiet', 'HEAD'])
					: undefined;
				return `repository at ${head?.ok === true ? head.value.stdout.toString('utf8').trim() : 'none'}`;
			}
			const info = await lstat(at, { bigint: true }).catch(() => undefined);
			return info === undefined
				? 'absent'
				: `${String(info.mode)} ${String(info.size)} ${String(info.mtimeNs)} ${String(info.ctimeNs)} ${String(info.ino)}`;
		})
	);
}

/** The source's fingerprint now; see the top of this file for its cost and its limits. */
export async function sourceIdentity(
	repo: LocalRepository,
	spec: GitSourceSpec
): Promise<Result<SourceIdentity, GitSourceError>> {
	switch (spec.kind) {
		case 'commit': {
			const commit = await resolveCommit(repo, spec.revision);
			return commit.ok ? ok(fingerprint(['commit', commit.value])) : commit;
		}
		case 'range': {
			const from = await resolveCommit(repo, spec.from);
			if (!from.ok) return from;
			const to = await resolveCommit(repo, spec.to);
			return to.ok ? ok(fingerprint(['range', from.value, to.value])) : to;
		}
		case 'staged': {
			if (repo.workTree === undefined) {
				return {
					ok: false,
					error: { kind: 'NoWorkingTree', repository: repo.commonDir, source: 'staged' }
				};
			}
			const head = await headCommit(repo);
			if (!head.ok) return head;
			const entries = await indexEntries(repo);
			return entries.ok
				? ok(fingerprint(['staged', head.value ?? 'none', entries.value]))
				: entries;
		}
		case 'working-tree': {
			const head = await headCommit(repo);
			if (!head.ok) return head;
			const status = await workingTreeStatus(repo);
			if (!status.ok) return status;
			const disk = await onDisk(repo, status.value);
			return ok(fingerprint(['working-tree', head.value ?? 'none', status.value.raw, ...disk]));
		}
	}
}
