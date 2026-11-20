/**
 * `pnpm fixtures:capture`: rebuilds the fixture repositories of
 * `tests/support/diff-fixtures.ts` with real git and records the output of the
 * diff command that `readDiff` runs, as the core parser's test fixtures in
 * `src/lib/core/diff/fixtures/`. Run it after changing a fixture or the command;
 * never edit the recorded files by hand.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffTreeArgs } from '#lib/server/git/read-diff.ts';
import { runGit } from '#lib/server/git/run-git.ts';
import { diffFixtures } from '../tests/support/diff-fixtures.ts';
import { absolutePath, GitRepo } from '../tests/support/git-repo.ts';

const outputDir = join(import.meta.dirname, '..', 'src', 'lib', 'core', 'diff', 'fixtures');
const scratch = await mkdtemp(join(tmpdir(), 'diff-delver-capture-'));
try {
	for (const fixture of diffFixtures) {
		const repo = await GitRepo.init(absolutePath(join(scratch, fixture.name)), fixture.options);
		await fixture.build(repo);
		const base = await repo.snapshot('base');
		const head = await repo.snapshot('head');
		const output = await runGit({ cwd: repo.dir, args: diffTreeArgs(base.tree, head.tree) });
		if (!output.ok) throw new Error(`git failed for ${fixture.name}: ${output.error.kind}`);
		const file = join(outputDir, `${fixture.name}.diff-tree`);
		await writeFile(file, output.value.stdout);
		console.log(`Wrote ${file} (${String(output.value.stdout.length)} bytes)`);
	}
} finally {
	await rm(scratch, { recursive: true, force: true });
}
