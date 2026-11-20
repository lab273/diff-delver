import { describe, expect, it } from 'vitest';
import { compileGlob, parseGlobPattern } from '../glob-pattern.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import type { Role } from '../role.tiny.ts';
import { syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { autoIgnore } from './auto-ignore.ts';
import { assign } from './assign.ts';
import {
	guessRole,
	IGNORE_RULES,
	ignoreRuleFor,
	ignoreRuleName,
	type IgnoreRuleId
} from './path-rules.ts';
import { initialState } from './state.ts';

function path(value: string): RepoPath {
	const parsed = parseRepoPath(value);
	if (!parsed.ok) throw new Error(`bad path ${value}`);
	return parsed.value;
}

describe('guessRole', () => {
	it.each<[string, Role]>([
		['src/app.ts', 'code'],
		['src/app.test.ts', 'test'],
		['src/app.spec.tsx', 'test'],
		['pkg/server/handler_test.go', 'test'],
		['tests/test_models.py', 'test'],
		['app/conftest.py', 'test'],
		['spec/models/user_spec.rb', 'test'],
		['src/test/java/com/x/UserServiceTest.java', 'test'],
		['Tests/AppTests.swift', 'test'],
		['src/__tests__/button.js', 'test'],
		['internal/testdata/input.json', 'test'],
		['src/__snapshots__/app.test.ts.snap', 'snapshot'],
		['src/snapshots/my_crate__parse.snap', 'snapshot'],
		['tests/__snapshots__/test_api.ambr', 'snapshot'],
		['tests/login.spec.ts-snapshots/home-chromium-linux.png', 'snapshot'],
		['src/__image_snapshots__/button-diff.png', 'snapshot'],
		['app/src/test/snapshots/images/com.x_ButtonTest_default.png', 'snapshot'],
		['Tests/__Snapshots__/ViewTests/testView.1.png', 'snapshot'],
		['tests/Api.Get.verified.json', 'snapshot'],
		['latest.ts', 'code'],
		['src/contest.ts', 'code']
	])('%s is %s', (p, role) => {
		expect(guessRole(path(p))).toBe(role);
	});

	it('lets project rules come first', () => {
		const glob = parseGlobPattern('qa/**');
		if (!glob.ok) throw new Error('bad glob');
		const rules = [{ role: 'test' as const, matches: compileGlob(glob.value) }];
		expect(guessRole(path('qa/checkout.ts'), rules)).toBe('test');
		expect(guessRole(path('qa/checkout.ts'))).toBe('code');
	});
});

describe('ignoreRuleFor', () => {
	it.each<[string, IgnoreRuleId | undefined]>([
		['pnpm-lock.yaml', 'lockfile'],
		['web/package-lock.json', 'lockfile'],
		['Cargo.lock', 'lockfile'],
		['go.sum', 'lockfile'],
		['static/app.min.js', 'minified'],
		['vendor/github.com/x/y.go', 'vendored'],
		['third_party/zlib/zlib.h', 'vendored'],
		['api/user.pb.go', 'generated'],
		['proto/user_pb2.py', 'generated'],
		['lib/model.g.dart', 'generated'],
		['src/__generated__/schema.ts', 'generated'],
		['dist/app.js.map', 'generated'],
		['src/app.ts', undefined],
		['docs/vendors.md', undefined],
		['package.json', undefined]
	])('%s is %s', (p, rule) => {
		expect(ignoreRuleFor(path(p))).toBe(rule);
	});

	it('names every rule for the reviewer', () => {
		for (const rule of IGNORE_RULES) expect(ignoreRuleName(rule.id).length).toBeGreaterThan(3);
	});
});

describe('autoIgnore', () => {
	const diff = syntheticDiff([
		{ path: 'api/user.pb.go', change: 'added', lines: 3 },
		{ path: 'pnpm-lock.yaml', change: 'modified', hunks: [{ gap: 0, lines: ['-', '+'] }] },
		{ path: 'recorded/a.json', change: 'added', lines: 2 },
		{ path: 'src/app.ts', change: 'added', lines: 2 },
		{ path: 'src/schema.ts', change: 'added', lines: 2 }
	]);

	it('ignores files by project pattern, by attribute and by built-in rule', () => {
		const glob = parseGlobPattern('recorded/**');
		if (!glob.ok) throw new Error('bad glob');
		const outcome = autoIgnore(diff, initialState(diff), {
			projectPatterns: [glob.value],
			markedGenerated: new Set([path('src/schema.ts')])
		});
		expect(outcome.ignored).toEqual([
			{ path: 'api/user.pb.go', by: { kind: 'rule', rule: 'generated' }, units: 3 },
			{ path: 'pnpm-lock.yaml', by: { kind: 'rule', rule: 'lockfile' }, units: 2 },
			{ path: 'recorded/a.json', by: { kind: 'pattern', pattern: 'recorded/**' }, units: 2 },
			{ path: 'src/schema.ts', by: { kind: 'rule', rule: 'linguist-generated' }, units: 2 }
		]);
	});

	it('moves only uncategorised units', () => {
		const assigned = assign(diff, initialState(diff), [
			{ file: 'pnpm-lock.yaml', lines: '+1', section: 'deps' }
		]).state;
		const outcome = autoIgnore(diff, assigned);
		expect(outcome.ignored.find((i) => i.path === 'pnpm-lock.yaml')?.units).toBe(1);
		const lock = outcome.state.files.get(path('pnpm-lock.yaml'));
		expect(lock?.new.get(1)?.bucket).toEqual({
			kind: 'section',
			section: 'deps'
		});
		expect(autoIgnore(diff, outcome.state).ignored).toEqual([]);
	});
});
