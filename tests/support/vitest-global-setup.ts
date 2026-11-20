/**
 * Vitest global setup for the integration project: one temporary directory per
 * run, shared by the fixture cache and the per-test copies, removed afterwards.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const root = await mkdtemp(join(tmpdir(), 'diff-delver-tests-'));
	project.provide('fixtureRoot', root);
	return () => rm(root, { recursive: true, force: true });
}
