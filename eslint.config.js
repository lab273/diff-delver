import prettier from 'eslint-config-prettier';
import { builtinModules } from 'node:module';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import { corePurityPlugin } from './scripts/eslint-core-purity.ts';
import { JOURNEY_RESTRICTED_SYNTAX } from './scripts/eslint-journey-rules.ts';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

/** Files that define tiny types. The only place a type assertion (`as`) is allowed. */
const TINY_TYPE_FILES = ['src/lib/core/**/*.tiny.ts'];

/** Pure domain code: no Node, SvelteKit, Svelte, browser or server imports. */
const CORE_FILES = ['src/lib/core/**/*.ts'];

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Every Node built-in module, in both spellings: `fs`, `node:fs`, `fs/promises`. */
const NODE_BUILTINS = `^(?:node:|(?:${builtinModules
	.filter((name) => !name.startsWith('node:'))
	.map(escapeRegex)
	.join('|')})(?:/|$))`;

/**
 * A user-defined type guard (`(v): v is Brand => ...`) or assertion function
 * (`asserts v is Brand`) is an unchecked cast: it would let any file forge a tiny
 * type. Allowed only where tiny types are made. `asserts v`, with no type, only
 * narrows to truthy and stays allowed.
 */
const NO_TYPE_PREDICATES = {
	selector: 'TSTypePredicate[typeAnnotation]',
	message:
		'A type predicate is an unchecked cast. Parse the value with its tiny type, or return the narrowed value instead.'
};

/**
 * Tiny types that check nothing, made only where that kind of value comes from.
 * `gitStderr` labels what git wrote to stderr, so only the module that runs git
 * may make one; anything else could pass its own text off as git's.
 */
const LABEL_MAKERS = [
	{
		regex: 'git-stderr\\.tiny(?:\\.ts)?$',
		importNames: ['gitStderr'],
		message: 'Only src/lib/server/git/run-git.ts makes a GitStderr, from what git wrote.'
	}
];

/**
 * The tables' writes of a revision's sorting, which only the report service's
 * `SortingWrites` calls, counting each one, so a search index is never used
 * once its sorting has changed.
 */
const SORTING_WRITES = [
	{
		regex: 'db/tables/(?:sections|assignments|reading-steps)(?:\\.ts)?$',
		importNames: ['replaceSections', 'replaceAssignmentRows', 'replaceReadingSteps'],
		message:
			'Write sections, assignment rows and reading steps through SortingWrites (src/lib/server/reports/sorting-writes.ts), which counts each write for the search index.'
	}
];

/** Files that may write a revision's sorting directly: `SortingWrites`, the tables, and tests. */
const SORTING_WRITE_FILES = ['src/lib/server/reports/sorting-writes.ts', 'src/lib/server/db/**'];

/** Files that may use a label maker: the module that makes the value, and tests. */
const LABEL_MAKER_FILES = ['src/lib/server/git/run-git.ts', '**/*.test.ts'];

const IMPURE = 'Core is pure: pass this in from the edge.';

/** Journey tests: every step goes through the journey helper, by keyboard only. */
const JOURNEY_FILES = ['tests/journeys/**/*.ts'];

/** Syntax core code must not use, because it reads the clock or loads code at run time. */
const CORE_IMPURE_SYNTAX = [
	{
		selector: "NewExpression[callee.name='Date'][arguments.length=0]",
		message: '`new Date()` reads the clock. Take time from the Clock.'
	},
	{
		selector: "CallExpression[callee.name='Date']",
		message: '`Date()` reads the clock. Take time from the Clock.'
	},
	{ selector: 'ImportExpression', message: 'Core is pure: no dynamic imports.' }
];

/** Globals core code must not touch: the environment, the clock, randomness, I/O and timers. */
const CORE_IMPURE_GLOBALS = [
	// Every global is reachable through these, so they are closed as a whole.
	'globalThis',
	'global',
	'self',
	'window',
	// Node.
	'process',
	'Buffer',
	'require',
	'module',
	'__dirname',
	'__filename',
	// The browser.
	'document',
	'navigator',
	'location',
	'localStorage',
	'sessionStorage',
	'indexedDB',
	// I/O.
	'fetch',
	'XMLHttpRequest',
	'WebSocket',
	// The clock and randomness.
	'performance',
	'crypto',
	// Timers.
	'setTimeout',
	'setInterval',
	'setImmediate',
	'clearTimeout',
	'clearInterval',
	'clearImmediate',
	'queueMicrotask',
	'requestAnimationFrame'
];

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.strictTypeChecked,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: {
			parserOptions: { projectService: true },
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		// The rules from docs/DEVELOPING.md "Strong typing" that the compiler alone does not enforce.
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
			'@typescript-eslint/switch-exhaustiveness-check': [
				'error',
				{ considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true }
			],
			'@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
			'@typescript-eslint/consistent-type-imports': 'error',
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
			'no-restricted-syntax': ['error', NO_TYPE_PREDICATES],
			'no-new-func': 'error',
			'no-eval': 'error'
		},
		// Comments cannot switch rules off. Fix the code instead.
		linterOptions: { noInlineConfig: true }
	},
	{
		files: ['**/*.ts', '**/*.js', '**/*.svelte'],
		ignores: LABEL_MAKER_FILES,
		rules: {
			'no-restricted-imports': ['error', { patterns: [...LABEL_MAKERS, ...SORTING_WRITES] }]
		}
	},
	{
		files: SORTING_WRITE_FILES,
		ignores: LABEL_MAKER_FILES,
		rules: { 'no-restricted-imports': ['error', { patterns: LABEL_MAKERS }] }
	},
	{
		// A tiny type's parse function checks a value and then brands it.
		files: TINY_TYPE_FILES,
		rules: {
			'@typescript-eslint/consistent-type-assertions': [
				'error',
				{ assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }
			]
		}
	},
	{
		files: CORE_FILES,
		plugins: { core: corePurityPlugin },
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							regex: NODE_BUILTINS,
							message: 'Core is pure: it must not import Node built-in modules.'
						},
						{
							regex: '^(\\$app/|\\$env/|@sveltejs/|svelte($|/)|#lib/server/|#lib/(?!core/))',
							message: 'Core is pure: it imports only other core modules and pure libraries.'
						},
						{
							group: ['**/server/**', '**/routes/**'],
							message: 'Core is pure: it must not import server or UI code.'
						},
						...LABEL_MAKERS
					]
				}
			],
			'no-restricted-globals': [
				'error',
				...CORE_IMPURE_GLOBALS.map((name) => ({ name, message: IMPURE }))
			],
			'no-restricted-properties': [
				'error',
				{ object: 'Date', property: 'now', message: 'Take time from the Clock.' },
				{ object: 'Math', property: 'random', message: 'Pass randomness in from the edge.' }
			],
			'no-restricted-syntax': ['error', NO_TYPE_PREDICATES, ...CORE_IMPURE_SYNTAX],
			'core/purity': 'error'
		}
	},
	{
		files: JOURNEY_FILES,
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: '@playwright/test',
							message:
								'Journeys import test and expect from tests/support/journey.ts, whose steps check every screen.'
						}
					],
					patterns: [
						...LABEL_MAKERS,
						{
							regex: '^(?!\\.\\./support/journey\\.ts$)',
							message:
								'Journeys import only tests/support/journey.ts, which gives them everything they may use.'
						}
					]
				}
			],
			'no-restricted-syntax': ['error', NO_TYPE_PREDICATES, ...JOURNEY_RESTRICTED_SYNTAX]
		}
	},
	{
		// Tiny-type files may use type predicates, but are otherwise core like the rest.
		// This block comes after the core one because a later block replaces a rule's options.
		files: TINY_TYPE_FILES,
		rules: {
			'no-restricted-syntax': ['error', ...CORE_IMPURE_SYNTAX]
		}
	}
);
