/**
 * `pnpm fixtures:old-database`: rebuilds `src/lib/server/reports/fixtures/before-file-units/`,
 * a data folder written by the diff delver from before a file with lines could
 * also have a file-level unit (the commit before `a030e3ca`). That code stored
 * such a file's lines only, and counted its progress without the change to its
 * name or mode, so `before-file-units.test.ts` checks what today's code makes of it.
 *
 * It exports that commit's sources from git history into a temporary folder
 * (they run under Node as they are, with this clone's `node_modules`), builds a
 * few repositories with real git, and has the old report service open each one's
 * uncommitted changes, marking one of them reviewed throughout. The repositories
 * themselves are not kept: the data folder alone is what a page reads. Run it
 * only to change what the fixture holds; never edit the fixture by hand.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { absolutePath, GitRepo } from '../tests/support/git-repo.ts';

/** The last commit before file-level units beside lines. */
const OLD_COMMIT = 'a030e3ca~1';

const root = join(import.meta.dirname, '..');
const outputDir = join(root, 'src', 'lib', 'server', 'reports', 'fixtures', 'before-file-units');

const lines = (...text: readonly string[]): string => `${text.join('\n')}\n`;
const numbered = (name: string, count: number): readonly string[] =>
	Array.from({ length: count }, (_, i) => `${name} ${String(i + 1)}`);

/** The repositories, by folder name, each with uncommitted changes, and whether to mark them reviewed. */
const repositories: readonly {
	readonly name: string;
	readonly build: (repo: GitRepo) => Promise<void>;
	readonly markReviewed: boolean;
}[] = [
	{
		// A lockfile moved into a folder, with one line edited: every line is ignored by a built-in rule.
		name: 'moved-lockfile',
		markReviewed: false,
		build: async (repo) => {
			await repo.write('pnpm-lock.yaml', lines(...numbered('lock', 12)));
			await repo.write('README.md', '# App\n');
			await repo.commit('first');
			await repo.git('rm', '--quiet', '--cached', 'pnpm-lock.yaml');
			await rm(join(repo.dir, 'pnpm-lock.yaml'));
			const moved = [...numbered('lock', 12)];
			moved[5] = 'lock 6 changed';
			await repo.write('sub/pnpm-lock.yaml', lines(...moved));
		}
	},
	{
		// A file renamed with one line edited, and a file made executable with one line edited.
		name: 'renamed-and-executable',
		markReviewed: false,
		build: buildRenamedAndExecutable
	},
	{
		// The same, with every change marked reviewed.
		name: 'renamed-and-executable-reviewed',
		markReviewed: true,
		build: buildRenamedAndExecutable
	}
];

async function buildRenamedAndExecutable(repo: GitRepo): Promise<void> {
	await repo.write('notes/a.txt', lines(...numbered('note', 12)));
	await repo.write('run.sh', lines('#!/bin/sh', ...numbered('step', 8)));
	await repo.commit('first');
	await rm(join(repo.dir, 'notes', 'a.txt'));
	const renamed = [...numbered('note', 12)];
	renamed[3] = 'note 4 changed';
	await repo.write('notes/b.txt', lines(...renamed));
	const run = ['#!/bin/sh', ...numbered('step', 8)];
	run[2] = 'step 2 changed';
	await repo.write('run.sh', lines(...run));
	await repo.setExecutable('run.sh', true);
}

/** Runs in the exported old sources: opens each repository's uncommitted changes. */
const driver = `
import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock } from '#lib/core/clock.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { ReportService } from '#lib/server/reports/index.ts';

const must = (result) => {
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
};
const [data, gitEnv, plan] = process.argv.slice(2).map((a, i) => (i === 0 ? a : JSON.parse(a)));
const service = must(
	await ReportService.open({
		dataDirectory: must(parseAbsolutePath(data)),
		clock: settableClock(must(parseTimestamp(1_700_000_000_000))),
		ids: sequentialIds(),
		repository: { gitEnv }
	})
);
const spec = must(parseGitSourceSpec('working-tree'));
for (const { dir, markReviewed } of plan) {
	const opened = must(await service.open(must(parseAbsolutePath(dir)), spec));
	if (opened.kind !== 'created') throw new Error(dir + ': ' + opened.kind);
	const id = opened.report.id;
	if (markReviewed) {
		const page = must(await service.load(id));
		for (const file of page.diff.files) {
			must(await service.markReviewed(id, { kind: 'file', path: file.file.path }, true));
		}
	}
}
for (const listed of must(service.list())) {
	console.log(listed.repository, JSON.stringify(listed.progress));
}
service.close();
`;

const scratch = await mkdtemp(join(tmpdir(), 'diff-delver-old-database-'));
try {
	const old = join(scratch, 'old');
	await mkdir(old);
	const archive = execFileSync('git', ['archive', OLD_COMMIT, 'package.json', 'src'], {
		cwd: root,
		maxBuffer: 1 << 30
	});
	execFileSync('tar', ['-x', '-C', old], { input: archive });
	await symlink(join(root, 'node_modules'), join(old, 'node_modules'));
	await writeFile(join(old, 'driver.ts'), driver);

	const plan: { dir: string; markReviewed: boolean }[] = [];
	for (const repository of repositories) {
		const repo = await GitRepo.init(absolutePath(join(scratch, 'repos', repository.name)));
		await repository.build(repo);
		plan.push({ dir: repo.dir, markReviewed: repository.markReviewed });
	}
	// The reviewer's git setup, made here and never the machine's.
	const home = join(scratch, 'home');
	await mkdir(join(home, 'xdg'), { recursive: true });
	await writeFile(join(home, 'gitconfig'), '');
	const gitEnv = {
		HOME: home,
		XDG_CONFIG_HOME: join(home, 'xdg'),
		GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
		GIT_CONFIG_NOSYSTEM: '1'
	};
	const data = join(scratch, 'data');
	await mkdir(data);
	const printed = execFileSync(
		process.execPath,
		['driver.ts', data, JSON.stringify(gitEnv), JSON.stringify(plan)],
		{ cwd: old, encoding: 'utf8' }
	);
	console.log(printed.trim());

	await rm(outputDir, { recursive: true, force: true });
	await mkdir(join(outputDir, '..'), { recursive: true });
	await cp(data, outputDir, { recursive: true });
	// What git puts in a new repository and never reads: not worth committing.
	for (const store of await readdir(join(outputDir, 'stores'))) {
		for (const unused of ['hooks', 'description', 'info']) {
			await rm(join(outputDir, 'stores', store, unused), { recursive: true, force: true });
		}
	}
	console.log(`Wrote ${outputDir}`);
} finally {
	await rm(scratch, { recursive: true, force: true });
}
