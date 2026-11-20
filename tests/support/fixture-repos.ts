/**
 * Named fixture repositories for integration tests: each is built once per test
 * run, keyed by its name and the source of its build script, and every test gets
 * its own copy in a fresh directory that is removed when the test finishes.
 *
 * Parallel-safe: workers that race to build the same fixture each build into a
 * private directory and the first to rename it into place wins.
 */
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inject, onTestFinished } from 'vitest';
import { absolutePath, GitRepo, type Fixture } from './git-repo.ts';

export { defineFixture, type Fixture } from './git-repo.ts';

declare module 'vitest' {
	export interface ProvidedContext {
		/** A directory created for this test run and removed after it. */
		fixtureRoot: string;
	}
}

const templates = new Map<string, Promise<string>>();

/** A private copy of the fixture for the current test. */
export async function useFixture(fixture: Fixture): Promise<GitRepo> {
	const root = inject('fixtureRoot');
	const key = `${fixture.name}-${createHash('sha256')
		.update(JSON.stringify(fixture.options) + fixture.build.toString())
		.digest('hex')
		.slice(0, 12)}`;
	let template = templates.get(key);
	if (template === undefined) {
		template = buildTemplate(root, key, fixture);
		templates.set(key, template);
	}
	const source = await template;

	const dir = join(root, 'tests', randomUUID());
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	await cp(source, dir, { recursive: true, verbatimSymlinks: true });
	return GitRepo.open(absolutePath(dir));
}

/** A fresh empty repository for the current test. */
export async function emptyRepo(): Promise<GitRepo> {
	const dir = join(inject('fixtureRoot'), 'tests', randomUUID());
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return GitRepo.init(absolutePath(dir));
}

async function buildTemplate(root: string, key: string, fixture: Fixture): Promise<string> {
	const done = join(root, 'templates', key);
	if (await exists(done)) return done;
	const building = join(root, 'building', randomUUID());
	await fixture.build(await GitRepo.init(absolutePath(building), fixture.options));
	await mkdir(join(root, 'templates'), { recursive: true });
	try {
		await rename(building, done);
	} catch {
		// Another worker finished first; theirs is identical.
		await rm(building, { recursive: true, force: true });
	}
	return done;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false
	);
}
