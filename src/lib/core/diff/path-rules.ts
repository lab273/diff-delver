/**
 * Guesses from a file's path alone: its role (DESIGN 4.4, 8.4) and whether a
 * built-in rule ignores it (DESIGN 4.2). The rules are data: add a glob to a
 * list, or a rule to a table, and give a new rule a short name, because the
 * reviewer sees that name as the reason.
 */
import { compileGlob, parseGlobPattern, type GlobMatcher } from '../glob-pattern.tiny.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { Role } from '../role.tiny.ts';

interface PathRule<Id extends string> {
	readonly id: Id;
	/** What the reviewer sees, such as "Lockfile". */
	readonly name: string;
	readonly globs: readonly string[];
}

/** Snapshot files and directories of common test tools. Checked before the test rules. */
const SNAPSHOT_GLOBS = [
	'**/__snapshots__/**', // Jest, Vitest, syrupy
	'*.snap', // Jest, Vitest, insta
	'*.snap.new', // insta, pending
	'*.ambr', // syrupy
	'**/__image_snapshots__/**', // jest-image-snapshot
	'**/*-snapshots/**', // Playwright: `example.spec.ts-snapshots/`
	'**/src/test/snapshots/**', // Paparazzi
	'**/__Snapshots__/**', // swift-snapshot-testing
	'*.verified.*', // Verify (.NET)
	'*.approved.*' // ApprovalTests
];

/** Test files and directories across ecosystems. */
const TEST_GLOBS = [
	'*.test.*', // JavaScript, TypeScript
	'*.spec.*',
	'*_test.*', // Go, Python, C++, Dart, Elixir
	'test_*.py', // pytest
	'conftest.py',
	'*_spec.rb', // RSpec
	'*Test.java',
	'*Tests.java',
	'*Test.kt',
	'*Tests.kt',
	'*Test.cs',
	'*Tests.cs',
	'*Tests.swift',
	'*Test.php',
	'**/__tests__/**',
	'**/test/**',
	'**/tests/**',
	'**/spec/**',
	'**/testdata/**',
	'**/e2e/**',
	'**/cypress/**'
];

export const ROLE_RULES = [
	{ id: 'snapshot-file', name: 'Snapshot file', role: 'snapshot', globs: SNAPSHOT_GLOBS },
	{ id: 'test-file', name: 'Test file', role: 'test', globs: TEST_GLOBS }
] as const satisfies readonly (PathRule<string> & { readonly role: Role })[];

export const IGNORE_RULES = [
	{
		// Matched by attribute, not by path: the caller reads `.gitattributes`.
		id: 'linguist-generated',
		name: 'Marked as generated in .gitattributes',
		globs: []
	},
	{
		id: 'lockfile',
		name: 'Lockfile',
		globs: [
			'package-lock.json',
			'npm-shrinkwrap.json',
			'pnpm-lock.yaml',
			'yarn.lock',
			'bun.lock',
			'bun.lockb',
			'deno.lock',
			'Cargo.lock',
			'Gemfile.lock',
			'poetry.lock',
			'uv.lock',
			'Pipfile.lock',
			'pdm.lock',
			'composer.lock',
			'go.sum',
			'flake.lock',
			'mix.lock',
			'pubspec.lock',
			'Podfile.lock',
			'Package.resolved',
			'packages.lock.json',
			'gradle.lockfile',
			'*.terraform.lock.hcl'
		]
	},
	{
		id: 'minified',
		name: 'Minified file',
		globs: ['*.min.js', '*.min.mjs', '*.min.cjs', '*.min.css', '*-min.js']
	},
	{
		id: 'vendored',
		name: 'Vendored code',
		globs: [
			'**/vendor/**',
			'**/node_modules/**',
			'**/third_party/**',
			'**/third-party/**',
			'**/bower_components/**',
			'**/Pods/**',
			'**/.yarn/releases/**'
		]
	},
	{
		id: 'generated',
		name: 'Generated file',
		globs: [
			'*.pb.go',
			'*.pb.cc',
			'*.pb.h',
			'*.pb.swift',
			'*_pb2.py',
			'*_pb2.pyi',
			'*_pb2_grpc.py',
			'*_pb.js',
			'*_pb.d.ts',
			'*.g.dart',
			'*.freezed.dart',
			'*.g.cs',
			'*.designer.cs',
			'*.Designer.cs',
			'*.generated.*',
			'zz_generated.*',
			'**/__generated__/**',
			'*.js.map',
			'*.mjs.map',
			'*.cjs.map',
			'*.css.map',
			'.pnp.cjs',
			'.pnp.loader.mjs'
		]
	}
] as const satisfies readonly PathRule<string>[];

/** The id of a built-in ignore rule, stored with what it ignored. */
export type IgnoreRuleId = (typeof IGNORE_RULES)[number]['id'];

/** The id of a built-in role rule. */
export type RoleRuleId = (typeof ROLE_RULES)[number]['id'];

function compileAll(globs: readonly string[]): GlobMatcher {
	const matchers = globs.map((glob) => {
		const parsed = parseGlobPattern(glob);
		if (!parsed.ok) throw new Error(`A built-in glob does not compile: ${glob}`);
		return compileGlob(parsed.value);
	});
	return (path) => matchers.some((matches) => matches(path));
}

const compiledRoleRules = ROLE_RULES.map((rule) => ({ ...rule, matches: compileAll(rule.globs) }));
const compiledIgnoreRules = IGNORE_RULES.map((rule) => ({
	...rule,
	matches: compileAll(rule.globs)
}));

/** A project's own role rule, such as `{ role: 'test', matches: compileGlob('qa/**') }`. */
export interface ProjectRoleRule {
	readonly role: Role;
	readonly matches: GlobMatcher;
}

/**
 * The role a file probably has, from its path. Project rules come first, then
 * snapshots, then tests; anything else is code.
 */
export function guessRole(path: RepoPath, projectRules: readonly ProjectRoleRule[] = []): Role {
	for (const rule of projectRules) if (rule.matches(path)) return rule.role;
	for (const rule of compiledRoleRules) if (rule.matches(path)) return rule.role;
	return 'code';
}

/** The built-in rule that ignores a path, if any. */
export function ignoreRuleFor(path: RepoPath): IgnoreRuleId | undefined {
	return compiledIgnoreRules.find((rule) => rule.matches(path))?.id;
}

/** The name the reviewer sees for a built-in ignore rule. */
export function ignoreRuleName(id: IgnoreRuleId): string {
	return IGNORE_RULES.find((rule) => rule.id === id)?.name ?? id;
}
