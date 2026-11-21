/**
 * Every committed recording (tests/agent-trials/recordings/), replayed through
 * the real stdio shim to a real daemon on the same fixture repository, with
 * the trial's fixed clock and sequential ids: each call is accepted or refused
 * as it was, and the diff ends up sorted exactly as the agent left it. A
 * recording made with an older tool surface or skill, and an answer worded
 * differently since, are reported where `pnpm verify` lists its warnings, not
 * failed: the recording can be recorded again.
 *
 * Also: no recording holds personal or machine-specific data, since they are
 * public.
 */
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ALLOWED_EMAILS, PRIVATE_TERMS_FILE } from '../../scripts/issue-tracker-identity.ts';
import { parsePrivateTerms, scanText } from '../../scripts/private-data-scan.ts';
import { defineFixture, tempDirectory, useFixture } from '../support/fixture-repos.ts';
import { absolutePath } from '../support/git-repo.ts';
import { mcpThroughShim } from '../support/mcp-client.ts';
import { reviewer } from '../support/reviewer-git.ts';
import { recordNotice } from '../support/test-notices.ts';
import { normaliser, olderThan, recordAgain, type Recording } from './recording.ts';
import { committedRecordings, replay } from './replay.ts';
import {
	builtVersion,
	currentHashes,
	sortedReports,
	startTrialDaemon,
	TRIAL_FIXTURES,
	trialFixture,
	type TrialFixtureName
} from './trial-world.ts';

const recordings = await committedRecordings();

const FIXTURES = Object.fromEntries(
	Object.entries(TRIAL_FIXTURES).map(([name, f]) => [name, defineFixture(`trial-${name}`, f.build)])
);

let version: ReturnType<typeof builtVersion> | undefined;

/** A copy of the fixture in a folder of its name, as the trial had it. */
async function repositoryFor(fixture: TrialFixtureName): Promise<string> {
	const template = FIXTURES[fixture];
	if (template === undefined) throw new Error(`No fixture ${fixture}`);
	const built = await useFixture(template);
	const repository = join(await tempDirectory(), fixture);
	await cp(built.dir, repository, { recursive: true, verbatimSymlinks: true });
	return repository;
}

async function replayed(recording: Recording): Promise<{
	readonly changed: readonly string[];
	readonly reworded: readonly number[];
	readonly finalState: Awaited<ReturnType<typeof sortedReports>>;
}> {
	const fixture = trialFixture(recording.fixture);
	if (fixture === undefined) {
		throw new Error(`The recording is of a fixture there is no longer: ${recording.fixture}`);
	}
	const repository = await repositoryFor(fixture);
	const trial = await tempDirectory();
	const data = absolutePath(join(trial, 'data'));
	const who = await reviewer();
	version ??= builtVersion();
	const daemon = await startTrialDaemon(data, { gitEnv: who.gitEnv }, await version);
	onTestFinished(() => daemon.stop());
	const env: Record<string, string | undefined> = { ...process.env, ...who.gitEnv };
	delete env['DIFF_DELVER_DATA_DIRECTORY'];
	const session = await mcpThroughShim({ cwd: repository, dataDirectory: data, env });
	const normalise = normaliser({ repository, data, trial });
	let outcome;
	try {
		outcome = await replay(recording, session, { repository, data, trial }, normalise);
	} finally {
		await session.close();
		await daemon.stop();
	}
	const finalState = await sortedReports(data, { gitEnv: who.gitEnv });
	return { ...outcome, finalState };
}

describe('agent trial recordings', () => {
	it('are committed', () => {
		expect(recordings.length).toBeGreaterThan(0);
	});

	for (const { name, recording } of recordings) {
		it(`replay as recorded: ${name}`, async ({ task }) => {
			const { changed, reworded, finalState } = await replayed(recording);
			expect(
				changed,
				`${name}: the tools now answer these recorded calls differently. Record the trial again (${recordAgain(recording)}), or find what changed.`
			).toEqual([]);
			expect(
				finalState,
				`${name}: replaying the calls no longer sorts the diff as the agent left it.`
			).toEqual(recording.finalState);
			// Not failures: the recording still replays, but is not what an agent would see now.
			const older = olderThan(recording, currentHashes());
			if (older.length > 0) {
				recordNotice(
					task,
					`The agent trial ${name} was recorded with an older version of ${older.join(' and ')}. Record it again with ${recordAgain(recording)} when the difference matters to an agent.`
				);
			}
			if (reworded.length > 0) {
				recordNotice(
					task,
					`The agent trial ${name} is older than the current answers: ${reworded.length === 1 ? 'call' : 'calls'} ${reworded.join(', ')} ${reworded.length === 1 ? 'is' : 'are'} answered in other words now. Record it again with ${recordAgain(recording)} when the wording matters.`
				);
			}
		});
	}

	it('hold no personal or machine-specific data', async () => {
		const findings: string[] = [];
		// The same private terms `pnpm bd push` checks for: a file of the developer's own,
		// never committed. Where there is none, as in CI, the patterns below still hold.
		// Never the name of whoever runs the test: on another machine that is another
		// word, which the fixtures may well contain.
		const privateTerms = await readFile(
			join(import.meta.dirname, '../..', PRIVATE_TERMS_FILE),
			'utf8'
		)
			.then(parsePrivateTerms)
			.catch(() => []);
		for (const { name } of recordings) {
			const text = await readFile(join(import.meta.dirname, 'recordings', name), 'utf8');
			for (const found of scanText(text, {
				allowedEmails: [...ALLOWED_EMAILS, 'fixture@example.invalid', 'accounts@example.com'],
				privateTerms
			})) {
				findings.push(`${name}: ${found.kind} ${found.shown}`);
			}
			const patterns: readonly [string, RegExp][] = [
				['a temporary path', /(?:^|[\s"'(])\/(?:tmp|var\/folders|private)\/[^\s"']*/g],
				[
					'a temporary path written as a folder name',
					/(?:^|[\s"'(/])-(?:tmp|var-folders|private)-[A-Za-z0-9-]*/g
				],
				['a login shell', /\/(?:usr\/)?(?:local\/)?bin\/(?:zsh|bash|fish)\b/g],
				['an address with a port', /127\.0\.0\.1:\d+/g],
				['an entry code', /[?&](?:entry|code)=(?!<code>)[A-Za-z0-9_-]+/g],
				[
					'an id like a session or account id',
					/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
				],
				['a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g]
			];
			for (const [what, pattern] of patterns) {
				for (const match of text.matchAll(pattern)) {
					findings.push(`${name}: ${what}: ${match[0].slice(0, 60)}`);
				}
			}
		}
		expect(findings).toEqual([]);
	});
});
