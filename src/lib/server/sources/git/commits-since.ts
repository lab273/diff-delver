/**
 * Where uncommitted or staged changes went once they are no longer there
 * (DESIGN 6.1): the commits made on top of the commit they were made on, if
 * HEAD has moved on from it. Only reads the repository; anything git cannot
 * tell, or any failure, is `unknown`, because this only chooses what to offer.
 */
import { parseCommitId, type CommitId } from '#lib/core/commit-id.tiny.ts';
import { parseCommitSubject } from '#lib/core/commit-subject.tiny.ts';
import type { CommitsSince } from '#lib/core/reports/nothing-left.ts';
import { gitCwd, gitIn, type LocalRepository } from './local-repository.ts';
import { headCommit } from './resolve.ts';

/** The commits made since `base`, the commit the changes were made on, up to HEAD. */
export async function commitsSince(
	repo: LocalRepository,
	base: CommitId | undefined
): Promise<CommitsSince> {
	if (base === undefined) return { kind: 'unknown' };
	const head = await headCommit(repo);
	if (!head.ok || head.value === undefined) return { kind: 'unknown' };
	if (head.value === base) return { kind: 'none' };
	const ancestor = await gitIn(repo, gitCwd(repo), [
		'merge-base',
		'--is-ancestor',
		'--end-of-options',
		base,
		head.value
	]);
	if (!ancestor.ok) return { kind: 'unknown' };
	// The first two commits after the base, newest first: one is all this needs to tell apart.
	const listed = await gitIn(repo, gitCwd(repo), [
		'rev-list',
		'--max-count=2',
		'--format=%H %s',
		'--no-commit-header',
		'--end-of-options',
		`${base}..${head.value}`
	]);
	if (!listed.ok) return { kind: 'unknown' };
	const lines = listed.value.stdout
		.toString('utf8')
		.split('\n')
		.filter((line) => line !== '');
	if (lines.length > 1) return { kind: 'several', base, head: head.value };
	const [line] = lines;
	if (line === undefined) return { kind: 'unknown' };
	const space = line.indexOf(' ');
	const commit = parseCommitId(space < 0 ? line : line.slice(0, space));
	if (!commit.ok) return { kind: 'unknown' };
	const subject = parseCommitSubject(space < 0 ? '' : line.slice(space + 1));
	return {
		kind: 'one',
		commit: commit.value,
		subject: subject.ok && subject.value !== '' ? subject.value : undefined
	};
}
