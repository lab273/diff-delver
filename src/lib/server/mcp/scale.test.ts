/**
 * The agent interface at the size the design promises: 2,000 files and 200,000
 * changed lines, through MCP over HTTP to a daemon in the test's process. Every
 * answer stays under the length agent clients keep (about 60,000 characters),
 * the manifest and the diff page through every file, and each call's time is
 * recorded against guidance, which `pnpm verify` reports when exceeded.
 */
import { describe, expect, it } from 'vitest';
import { measurementName } from '#lib/core/measurement-name.tiny.ts';
import { millisecondsOf } from '#lib/core/milliseconds.tiny.ts';
import { testDaemon } from '../../../../tests/support/daemons.ts';
import { useFixture } from '../../../../tests/support/fixture-repos.ts';
import { FILES, largeChange } from '../../../../tests/support/large-change.ts';
import { recordTime, type MeasuredTask } from '../../../../tests/support/measured-time.ts';
import {
	cursorIn,
	mcpOverHttp,
	reportIn,
	type McpSession,
	type ToolAnswer
} from '../../../../tests/support/mcp-client.ts';
import { now } from '../../../../tests/support/stopwatch.ts';

/** What agent clients keep of one tool answer, in characters, about. */
const MOST_KEPT = 60_000;

async function timedCall(
	task: MeasuredTask,
	session: McpSession,
	what: string,
	guidance: number,
	tool: string,
	args: Readonly<Record<string, unknown>>
): Promise<ToolAnswer> {
	const started = now();
	const answer = await session.call(tool, args);
	recordTime(
		task,
		measurementName(what),
		millisecondsOf(now() - started),
		millisecondsOf(guidance)
	);
	expect(answer.refused, `${tool}: ${answer.text.slice(0, 500)}`).toBe(false);
	expect(answer.text.length, tool).toBeLessThanOrEqual(MOST_KEPT);
	return answer;
}

describe('the agent interface at full scale', () => {
	it('keeps every answer short on 2,000 files and 200,000 changed lines', async ({ task }) => {
		const repo = await useFixture(largeChange);
		const daemon = await testDaemon();
		const session = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.token,
			directory: repo.dir
		});
		try {
			const created = await timedCall(
				task,
				session,
				'create_report of 2,000 files',
				4_000,
				'create_report',
				{ source: 'base...HEAD' }
			);
			const report = reportIn(created);
			expect(created.text).toMatch(
				/2,000 files changed, 100,000 lines added and 100,000 removed: 200,000 change lines, 200,000 not sorted yet\./
			);

			const seen = new Set<string>();
			let cursor: string | undefined;
			let pages = 0;
			do {
				const page = await timedCall(
					task,
					session,
					'a page of get_manifest of 2,000 files',
					500,
					'get_manifest',
					{
						report,
						...(cursor === undefined ? {} : { cursor })
					}
				);
				for (const line of page.text.split('\n'))
					if (line.startsWith('src/module-')) seen.add(line.split(':')[0] ?? '');
				cursor = cursorIn(page);
				pages += 1;
			} while (cursor !== undefined);
			expect(seen.size).toBe(FILES);
			expect(pages).toBeLessThanOrEqual(6);

			const diff = await timedCall(
				task,
				session,
				'the first page of get_diff of 2,000 files',
				500,
				'get_diff',
				{ report }
			);
			expect(diff.text).toMatch(/^The whole diff: files 1 to \d+ of 2,000\.$/m);
			const moduleDiff = await timedCall(
				task,
				session,
				'get_diff of one folder of 100 files',
				500,
				'get_diff',
				{
					report,
					files: ['src/module-07/**']
				}
			);
			expect(moduleDiff.text).toMatch(/^100 files asked for: files 1 to \d+ of 100\.$/m);

			const before = await timedCall(
				task,
				session,
				'get_coverage of 2,000 files, nothing sorted',
				500,
				'get_coverage',
				{ report }
			);
			expect(before.text).toMatch(/… and [\d,]+ more files\./);

			await session.call('upsert_sections', {
				report,
				version: 1,
				sections: [
					{ id: 'first', title: 'First half' },
					{ id: 'second', title: 'Second half' }
				]
			});
			const assigned = await timedCall(
				task,
				session,
				'one assign of 20 globs over 2,000 files',
				1_500,
				'assign',
				{
					report,
					version: 1,
					items: Array.from({ length: 20 }, (_, i) => ({
						glob: `src/module-${String(i).padStart(2, '0')}/**`,
						section: i < 10 ? 'first' : 'second'
					}))
				}
			);
			expect(assigned.text).toMatch(/Nothing is left to sort/);
			const after = await timedCall(
				task,
				session,
				'get_coverage of 2,000 files, all sorted',
				500,
				'get_coverage',
				{ report }
			);
			expect(after.text).toMatch(
				/200,000 change lines in 2,000 files: 200,000 in sections, 0 ignored, 0 not sorted yet\./
			);
			// A section of 100,000 lines is too large to review in one sitting, and is told so.
			expect(after.text).toMatch(/Section "first" has 100000 changed lines, more than 800/);
		} finally {
			await session.close();
		}
	});
});
