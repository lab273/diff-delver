/**
 * What a run of commits is made of, for its diff's title (`core/history/commit-run.ts`):
 * how many commits it is and the subjects of its oldest and newest.
 *
 * A run is a range between two commit ids, `from` the first parent of its
 * oldest commit (or git's empty tree, from the repository's first commit) and
 * `to` its newest: what ticking commits on the choose page opens. A range
 * between two ids written by hand may not be one: `from` may lie off `to`'s
 * first parents, or share no history with it. Then there is no run, and the
 * diff is titled by its source alone.
 *
 * Read once, when the report is opened: ids never come to name other commits.
 * Only reads the repository; three short commands, none of which prints more
 * than a line.
 */
import { commitCountOf } from '#lib/core/history/commit-count.tiny.ts';
import type { CommitRun } from '#lib/core/history/commit-run.ts';
import { runSubjectOf } from '#lib/core/history/run-subject.tiny.ts';
import { subjectLineOf } from '#lib/core/history/subject-line.tiny.ts';
import { isEmptyTreeRevision, type GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { gitCwd, gitIn, type LocalRepository } from './local-repository.ts';

const FULL_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** What `log` writes of one commit: its parents, a NUL, and its subject. */
const PARENTS_AND_SUBJECT = '--format=%P%x00%s';

/**
 * The run of commits `spec` is, or undefined when it is not one: not a range
 * between two commit ids, or one whose `from` is not the first parent of the
 * oldest commit on `to`'s first parents. Undefined, too, when git cannot say,
 * since a title is not worth failing to open a diff for.
 */
export async function readCommitRun(
	repo: LocalRepository,
	spec: GitSourceSpec
): Promise<CommitRun | undefined> {
	if (spec.kind !== 'range' || !FULL_ID.test(spec.to)) return undefined;
	const fromNothing = isEmptyTreeRevision(spec.from);
	if (!fromNothing && !FULL_ID.test(spec.from)) return undefined;
	// The commits on `to`'s first parents that `from` does not have.
	const commits = [
		'--first-parent',
		'--end-of-options',
		spec.to,
		...(fromNothing ? [] : [`^${spec.from}`]),
		'--'
	];
	const counted = await gitIn(repo, gitCwd(repo), ['rev-list', '--count', ...commits]);
	if (!counted.ok) return undefined;
	const count = Number(counted.value.stdout.toString('utf8').trim());
	if (!Number.isSafeInteger(count) || count < 1) return undefined;
	const one = async (skip: number): Promise<{ parents: string[]; subject: string } | undefined> => {
		const logged = await gitIn(repo, gitCwd(repo), [
			'log',
			`--skip=${String(skip)}`,
			'--max-count=1',
			'--encoding=UTF-8',
			'--no-show-signature',
			PARENTS_AND_SUBJECT,
			...commits
		]);
		if (!logged.ok) return undefined;
		const [parents, subject] = logged.value.stdout.toString('utf8').replace(/\n$/, '').split('\0');
		if (parents === undefined || subject === undefined) return undefined;
		return { parents: parents.split(' ').filter((p) => p !== ''), subject };
	};
	const oldest = await one(count - 1);
	if (oldest === undefined) return undefined;
	// A run stops where `from` is: at the commit whose first parent it is, or the first commit of all.
	const below = oldest.parents[0];
	if (fromNothing ? below !== undefined : below !== spec.from) return undefined;
	const newest = count === 1 ? oldest : await one(0);
	if (newest === undefined) return undefined;
	return {
		commits: commitCountOf(count),
		oldest: runSubjectOf(subjectLineOf(oldest.subject)),
		newest: runSubjectOf(subjectLineOf(newest.subject))
	};
}
