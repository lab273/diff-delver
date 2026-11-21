/**
 * The release workflow's first job (`.github/workflows/release.yml`, README
 * "Releasing"): checks what the person who started it typed, before any work
 * is done. Every problem found is said, each with what to do.
 *
 *   node scripts/release-preflight.ts
 *
 * From the environment:
 *   RELEASE_VERSION  the version to release, such as 0.2.0 (the workflow's input)
 *   EXPECTED_COMMIT  the start of the id of the commit the person means to release
 *   COMMIT           the commit the run is on (GITHUB_SHA)
 *   REF              the branch or tag the run was started on (GITHUB_REF)
 *   TAGS_FILE        a file listing the repository's tags, one per line
 *   RELEASES_FILE    a file listing the tags of the repository's releases, drafts
 *                    included, one per line
 *   GITHUB_OUTPUT    when set, `version` and `tag` are written to it, once
 *                    every check has passed
 *
 * The checks: the run is on main; the version is three whole numbers, after
 * the newest release (and the newest version tag); no tag and no release of
 * that name exists; and the run's commit is the one the person expected.
 */
import { appendFile, readFile } from 'node:fs/promises';
import {
	compareReleases,
	parseReleaseVersion,
	releaseOfTag,
	releaseTag,
	type ReleaseTag,
	type ReleaseVersion
} from '../src/lib/core/release-version.tiny.ts';
import { err, ok, type Result } from '../src/lib/core/result.ts';

/** Releases are made from this branch only. */
export const RELEASE_BRANCH = 'refs/heads/main';

export interface PreflightInput {
	readonly version: string;
	readonly expectedCommit: string;
	readonly commit: string;
	readonly ref: string;
	readonly tags: readonly string[];
	readonly releases: readonly string[];
}

export interface Approved {
	readonly version: ReleaseVersion;
	readonly tag: ReleaseTag;
}

export type PreflightProblem =
	| { readonly kind: 'NotMain'; readonly ref: string }
	| { readonly kind: 'InvalidVersion'; readonly text: string }
	| { readonly kind: 'NotNewer'; readonly version: ReleaseVersion; readonly newest: ReleaseVersion }
	| { readonly kind: 'TagExists'; readonly tag: ReleaseTag }
	| { readonly kind: 'ReleaseExists'; readonly tag: ReleaseTag }
	| { readonly kind: 'InvalidExpectedCommit'; readonly text: string }
	| { readonly kind: 'UnexpectedCommit'; readonly expected: string; readonly commit: string };

/** What is wrong and what to do, for the person who started the release. */
export function describeProblem(problem: PreflightProblem): string {
	switch (problem.kind) {
		case 'NotMain':
			return `This run was started on ${problem.ref}, but releases are made only from main. Start the release again with "Use workflow from" set to main.`;
		case 'InvalidVersion':
			return `"${problem.text}" is not a version to release. Give three whole numbers with no "v" and no suffix, such as 0.2.0, and start the release again.`;
		case 'NotNewer':
			return `Version ${problem.version} is not after the newest release, ${problem.newest}. Give a later version, such as ${bumped(problem.newest)}, and start the release again.`;
		case 'TagExists':
			return `A tag named ${problem.tag} already exists, so that version cannot be released again. Give a later version and start the release again; if the tag was made by mistake, delete it on GitHub first.`;
		case 'ReleaseExists':
			return `A release for ${problem.tag} already exists (perhaps a draft). Give a later version and start the release again, or delete that release on GitHub first if it was made by mistake.`;
		case 'InvalidExpectedCommit':
			return `"${problem.text}" is not the start of a commit id. Copy at least the first 7 characters of the commit you mean to release from main's history on GitHub, and start the release again.`;
		case 'UnexpectedCommit':
			return `main is at ${problem.commit.slice(0, 12)}, not ${problem.expected}, the commit you expected: something was pushed after you looked, or the id is wrong. Look at main's history, then start the release again with the commit you mean to release.`;
	}
}

function bumped(version: ReleaseVersion): string {
	const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
	return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
}

export function preflight(input: PreflightInput): Result<Approved, readonly PreflightProblem[]> {
	const problems: PreflightProblem[] = [];
	if (input.ref !== RELEASE_BRANCH) problems.push({ kind: 'NotMain', ref: input.ref });

	const expected = input.expectedCommit.trim().toLowerCase();
	if (!/^[0-9a-f]{7,64}$/.test(expected)) {
		problems.push({ kind: 'InvalidExpectedCommit', text: input.expectedCommit });
	} else if (!input.commit.toLowerCase().startsWith(expected)) {
		problems.push({ kind: 'UnexpectedCommit', expected, commit: input.commit });
	}

	const version = parseReleaseVersion(input.version.trim());
	if (!version.ok) {
		problems.push({ kind: 'InvalidVersion', text: input.version });
		return err(problems);
	}
	const tag = releaseTag(version.value);
	if (input.tags.includes(tag)) problems.push({ kind: 'TagExists', tag });
	if (input.releases.includes(tag)) problems.push({ kind: 'ReleaseExists', tag });
	const released = [...input.tags, ...input.releases]
		.map(releaseOfTag)
		.filter((found) => found !== undefined);
	const newest = released.reduce<ReleaseVersion | undefined>(
		(best, found) => (best === undefined || compareReleases(found, best) > 0 ? found : best),
		undefined
	);
	if (
		newest !== undefined &&
		newest !== version.value &&
		compareReleases(version.value, newest) <= 0
	) {
		problems.push({ kind: 'NotNewer', version: version.value, newest });
	}
	return problems.length > 0 ? err(problems) : ok({ version: version.value, tag });
}

async function lines(path: string | undefined): Promise<readonly string[]> {
	if (path === undefined || path === '') return [];
	const text = await readFile(path, 'utf8');
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');
}

async function main(): Promise<number> {
	const env = process.env;
	const input: PreflightInput = {
		version: env['RELEASE_VERSION'] ?? '',
		expectedCommit: env['EXPECTED_COMMIT'] ?? '',
		commit: env['COMMIT'] ?? '',
		ref: env['REF'] ?? '',
		tags: await lines(env['TAGS_FILE']),
		releases: await lines(env['RELEASES_FILE'])
	};
	const checked = preflight(input);
	if (!checked.ok) {
		for (const problem of checked.error) {
			// A GitHub annotation, so the run's summary shows it.
			process.stdout.write(`::error title=The release was refused::${describeProblem(problem)}\n`);
		}
		return 1;
	}
	const { version, tag } = checked.value;
	process.stdout.write(`Releasing ${version} as ${tag} from ${input.commit}.\n`);
	const output = env['GITHUB_OUTPUT'];
	if (output !== undefined && output !== '') {
		await appendFile(output, `version=${version}\ntag=${tag}\n`);
	}
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main();
}
