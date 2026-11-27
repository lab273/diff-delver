/**
 * The live loop (DESIGN 7.1, 7.2) as an agent meets it, over the daemon's
 * `/mcp`, with the reviewer's side played by a report service of its own on
 * the same data folder: a request asked is handed over by `wait_for_requests`
 * and marked delivered, `answer_request` stores the answer with the code its
 * references point at, read from the snapshot, the frame has both, a second
 * wait with nothing asked says so, and the request never reaches the review.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseLineNumber } from '#lib/core/line-number.tiny.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { testDaemon } from '../../../../tests/support/daemons.ts';
import {
	defineFixture,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { mcpOverHttp, reportIn } from '../../../../tests/support/mcp-client.ts';
import { buildShop } from '../../../../tests/support/scripted-categorisation.ts';
import { ReportService } from '../reports/index.ts';

const shop = defineFixture('agent-requests-shop', buildShop);

describe('requests to the agent, through the MCP server', () => {
	it('hands a request over, takes its answer with excerpts, and keeps it out of the review', async () => {
		const repo = await useFixture(shop);
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory });
		const session = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.mcpToken,
			directory: repo.dir
		});
		onTestFinished(() => session.close());
		const report = reportIn(await session.call('create_report', { source: 'working-tree' }));
		const service = value(
			await ReportService.open({
				dataDirectory,
				ids: sequentialIds(),
				clock: settableClock(value(parseTimestamp(0)))
			})
		);
		onTestFinished(() => {
			service.close();
		});
		const id = value(parseReportId(report));
		const one = value(parseRevisionNumber(1));
		const cart = value(parseRepoPath('src/cart.ts'));

		// Asked before the agent waits, so the wait hands it over at once.
		const asked = value(
			await service.askAgent(
				id,
				one,
				{
					kind: 'lines',
					path: cart,
					side: 'new',
					first: value(parseLineNumber(3)),
					last: value(parseLineNumber(4))
				},
				'Explain this.'
			)
		);
		expect(asked.status).toBe('waiting');
		const refused = await service.askAgent(id, one, { kind: 'file', path: cart }, '   ');
		expect(refused.ok).toBe(false);

		const waited = await session.call('wait_for_requests', { report, timeout: 1 });
		expect(waited.refused).toBe(false);
		expect(waited.text).toContain(
			`1 request from the person, now delivered to you:\n- Request ${String(asked.id)}, about src/cart.ts, lines +3..+4 (the new side), asked on version 1:\n  "Explain this."`
		);
		expect(value(service.requests(id)).map((r) => r.status)).toEqual(['delivered']);

		const wrong = await session.call('answer_request', {
			request: asked.id,
			body: 'It totals the cart.',
			references: [{ file: 'src/nowhere.ts', lines: '1..2' }]
		});
		expect(wrong.refused).toBe(true);
		expect(wrong.text).toContain('Reference 0: "src/nowhere.ts" is not in the repository');

		const answer = {
			request: asked.id,
			body: 'The total now goes through `roundPrice`.',
			references: [{ file: 'src/pricing.ts', lines: '+1..+2' }]
		};
		const answered = await session.call('answer_request', answer);
		expect(answered.refused).toBe(false);
		expect(answered.text).toContain('beside what they asked about, with 1 excerpt of code');
		const again = await session.call('answer_request', answer);
		expect(again.text).toContain('has that answer already, so it was passed over');
		const ahead = await session.call('answer_request', { ...answer, version: 2 });
		expect(ahead.refused).toBe(true);
		expect(ahead.text).toContain('has no version 2');

		// The page's frame has the request, answered, with the code read from the snapshot.
		const loaded = value(await service.load(id));
		const [request] = loaded.requests;
		expect(request?.status).toBe('answered');
		expect(
			request?.answers.map((a) => [a.body, a.excerpts.map((e) => [e.path, e.first, e.last])])
		).toEqual([['The total now goes through `roundPrice`.', [['src/pricing.ts', 1, 2]]]]);
		expect(request?.answers[0]?.excerpts[0]?.lines).toHaveLength(2);

		// Nothing more asked: the next wait says so once its timeout passes.
		const idle = await session.call('wait_for_requests', { report, timeout: 1 });
		expect(idle.text).toContain('No requests from the person in the last 1 second.');
		expect(idle.text).toContain('call wait_for_requests again');

		// A request is conversation: finishing a review leaves it out until promoted.
		expect(value(service.draftComments(id))).toEqual([]);
		const promoted = value(await service.promoteRequest(id, one, asked.id));
		expect(promoted?.body).toBe(
			'I asked the agent:\n> Explain this.\n\nThe agent answered:\n> The total now goes through `roundPrice`.'
		);
		expect(value(await service.previewReview(id, one)).text).toContain('I asked the agent:');
	});
});
