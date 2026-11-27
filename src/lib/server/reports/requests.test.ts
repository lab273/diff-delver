/**
 * The report service's side of the live loop (DESIGN 7.2): a wait that is open
 * when a question is asked is woken at once; one whose caller has gone ends and
 * hands nothing over; a wait reports an update made since the last one; and
 * closing the service ends every wait. Waits here are short or woken, never
 * the 45 seconds an agent waits.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { emptyRepo, tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { ReportService } from './index.ts';

async function setUp() {
	const repo = await emptyRepo();
	await repo.write('src/app.ts', 'one\ntwo\n');
	await repo.commit('first');
	await repo.write('src/app.ts', 'one\n2\nthree\n');
	const who = await reviewer();
	const service = value(
		await ReportService.open({
			dataDirectory: await tempDirectory(),
			clock: settableClock(at(1_700_000_000_000)),
			ids: sequentialIds(),
			repository: { gitEnv: who.gitEnv }
		})
	);
	const opened = value(await service.open(repo.dir, value(parseGitSourceSpec('working-tree'))));
	if (opened.kind !== 'created') throw new Error('no report');
	return { repo, service, id: opened.report.id };
}

const one = value(parseRevisionNumber(1));
const file = value(parseRepoPath('src/app.ts'));

describe('waiting for the reviewer’s questions', () => {
	it('wakes a wait when a question is asked, and hands nothing over to a caller that has gone', async () => {
		const { service, id } = await setUp();
		onTestFinished(() => {
			service.close();
		});

		// A caller that has gone stops its wait, and the question stays waiting for the next.
		const gone = new AbortController();
		const abandoned = service.waitForRequests(id, 60_000, gone.signal);
		gone.abort();
		expect(value(await abandoned).stopped).toBe(true);
		// Asked after the caller went, it is not handed to the wait that was stopped.
		const early = value(await service.askAgent(id, one, { kind: 'file', path: file }, 'First?'));
		await Promise.resolve();
		expect(value(service.requests(id)).map((r) => [r.id, r.status])).toEqual([
			[early.id, 'waiting']
		]);

		// The next wait takes it at once.
		const taken = value(await service.waitForRequests(id, 60_000));
		expect(taken.requests.map((r) => [r.id, r.status])).toEqual([[early.id, 'delivered']]);

		// A wait open when a question is asked is woken by it.
		const waiting = service.waitForRequests(id, 60_000);
		const asked = value(await service.askAgent(id, one, { kind: 'file', path: file }, 'Why?'));
		const woken = value(await waiting);
		expect(woken.requests.map((r) => [r.id, r.status])).toEqual([[asked.id, 'delivered']]);
		expect(woken.unanswered.map((r) => r.id)).toEqual([early.id]);

		// Handed over and not answered, they come again, with what they ask, in the next wait.
		const next = value(await service.waitForRequests(id, 1));
		expect(next.requests).toEqual([]);
		expect(next.unanswered.map((r) => [r.id, r.question])).toEqual([
			[early.id, 'First?'],
			[asked.id, 'Why?']
		]);
	});

	it('reports an update since the last wait, and ends every wait when it closes', async () => {
		const { repo, service, id } = await setUp();
		expect(value(await service.waitForRequests(id, 1)).updated).toBeUndefined();
		await repo.write('src/app.ts', 'one\n2\nthree\nfour\n');
		value(await service.update(id));
		const after = value(await service.waitForRequests(id, 60_000));
		expect(after.updated).toBe(2);
		expect(value(await service.waitForRequests(id, 1)).updated).toBeUndefined();

		const open = service.waitForRequests(id, 60_000);
		service.close();
		expect(value(await open).requests).toEqual([]);
	});
});
