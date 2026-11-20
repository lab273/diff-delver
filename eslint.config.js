import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

/** Files that define tiny types. The only place a type assertion (`as`) is allowed. */
const TINY_TYPE_FILES = ['src/lib/core/**/*.tiny.ts'];

/** Pure domain code: no Node, SvelteKit, Svelte, browser or server imports. */
const CORE_FILES = ['src/lib/core/**/*.ts'];

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
		// The rules from README "Strong typing" that the compiler alone does not enforce.
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
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }]
		},
		// Comments cannot switch rules off. Fix the code instead.
		linterOptions: { noInlineConfig: true }
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
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							regex: '^(node:|\\$app/|\\$env/|@sveltejs/|svelte($|/)|#lib/server/|#lib/(?!core/))',
							message: 'Core is pure: it imports only other core modules and pure libraries.'
						},
						{
							group: ['**/server/**', '**/routes/**'],
							message: 'Core is pure: it must not import server or UI code.'
						}
					]
				}
			],
			'no-restricted-globals': [
				'error',
				...['process', 'window', 'document', 'navigator', 'localStorage', 'fetch'].map((name) => ({
					name,
					message: 'Core is pure: pass this in from the edge.'
				}))
			],
			'no-restricted-properties': [
				'error',
				{ object: 'Date', property: 'now', message: 'Take time from the Clock.' },
				{ object: 'Math', property: 'random', message: 'Pass randomness in from the edge.' }
			]
		}
	}
);
