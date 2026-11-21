/**
 * Searching a diff in the report service, against what the page finds: for
 * every part, the daemon counts what the page's own search finds in the lines
 * it fetches for that part (`ui/viewer/search-places.ts`), with each option,
 * in a diff whose file is split between sections, so a hunk holds lines of
 * another group and another hunk is folded away.
 */
import { describe, expect, it } from 'vitest';
import type { BlockState } from '#lib/ui/viewer/viewer.svelte.ts';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import type { GroupKey } from '#lib/core/diff/slices.ts';
import { parseSearchText } from '#lib/core/search/search-text.tiny.ts';
import { searchedQuery } from '#lib/core/search/find-text.ts';
import { shownRepoPath } from '#lib/core/shown-path.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { partLinesView } from '#lib/server/api/present.ts';
import { placesIn } from '#lib/ui/viewer/search-places.ts';
import { emptyRepo, tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { ReportService } from './index.ts';

const FIRST = value(parseRevisionNumber(1));

const before = Array.from({ length: 40 }, (_, i) => `const total${String(i)} = ${String(i)};`);
const after = before.map((line, i) =>
	i === 3 ? 'const Total3 = sum(3); // total' : i === 30 ? 'const total30 = TOTAL;' : line
);

describe('searching a diff', () => {
	it('counts in each part what the page finds in that part’s lines, with every option', async () => {
		const repo = await emptyRepo();
		await repo.write('src/sum.ts', `${before.join('\n')}\n`);
		await repo.write('src/total.md', 'nothing here\n');
		await repo.commit('first');
		await repo.write('src/sum.ts', `${after.join('\n')}\n`);
		await repo.write('src/total.md', 'a total, and Total\n');
		const who = await reviewer();
		const service = value(
			await ReportService.open({
				dataDirectory: await tempDirectory(),
				clock: settableClock(at(1_700_000_000_000)),
				ids: sequentialIds(''),
				repository: { gitEnv: who.gitEnv },
				log: () => undefined
			})
		);
		try {
			const opened = value(await service.open(repo.dir, value(parseGitSourceSpec('working-tree'))));
			if (opened.kind !== 'created') throw new Error(opened.kind);
			const id = opened.report.id;
			value(await service.upsertSections(id, FIRST, [{ id: 'early', title: 'Early' }]));
			// The first hunk's added line goes to a section; its removed line stays unsorted.
			value(
				await service.assign(id, FIRST, [{ file: 'src/sum.ts', lines: '+4', section: 'early' }])
			);

			const page = value(await service.load(id));
			for (const text of ['total', 'Total', 'TOTAL', 'sum', '3', 'const total', 'nowhere']) {
				const query = value(parseSearchText(text));
				for (const matchCase of [false, true]) {
					for (const changedOnly of [false, true]) {
						const options = { matchCase, changedOnly };
						const found = value(await service.searchDiff(id, FIRST, 'sections', query, options));
						const groups: readonly GroupKey[] = [
							{ kind: 'section', section: value(parseSectionId('early')) },
							{ kind: 'uncategorised' }
						];
						const parts = page.diff.files.flatMap((file) =>
							groups.map((group) => ({ file, group }))
						);
						let seen = 0;
						for (const { file, group } of parts) {
							const g = group.kind;
							const content = await service.readPart(id, FIRST, 'sections', group, file.file.path);
							if (!content.ok) continue;
							const blocks = partLinesView(content.value).blocks.map((block): BlockState => {
								switch (block.kind) {
									case 'hidden':
										return { ...block, top: [], bottom: [], busy: false, problem: '' };
									case 'hunk':
										return { ...block, showWhiteSpace: false };
									case 'elsewhere':
										return { ...block, shown: false };
								}
							});
							const onPage = placesIn(
								shownRepoPath(file.file.path),
								blocks,
								searchedQuery(query, matchCase),
								options
							).length;
							const counted =
								found.find((p) => p.path === file.file.path && p.group.kind === group.kind)
									?.matches ?? 0;
							expect(counted, `${text} ${JSON.stringify(options)} in ${g} ${file.file.path}`).toBe(
								onPage
							);
							seen += 1;
						}
						expect(seen).toBe(3);
					}
				}
			}
			const total = value(parseSearchText('total'));
			const counts = value(
				await service.searchDiff(id, FIRST, 'sections', total, {
					matchCase: false,
					changedOnly: false
				})
			);
			expect(counts.map((p) => [p.group.kind, p.path, p.matches])).toEqual([
				// Its own hunk, with the removed line that is not sorted yet among it.
				['section', 'src/sum.ts', 9],
				// The same hunk, its line in the section muted among it, and the second hunk.
				['uncategorised', 'src/sum.ts', 18],
				// Its path, and its added line twice; the removed line has none.
				['uncategorised', 'src/total.md', 3]
			]);
		} finally {
			service.close();
		}
	});
});
