/**
 * The lint rule that keeps the clock, the timezone, the locale and the build
 * environment out of core (`eslint-core-purity.ts`), run on planted code. Without type information, so the checks of `toString()` and
 * `String(...)` of a Date, which need the type checker, are not covered here.
 */
import { Linter } from 'eslint';
import ts from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { corePurityPlugin } from './eslint-core-purity.ts';

const linter = new Linter({ configType: 'flat' });

/** The rule's messages for a piece of core code. */
function problems(code: string): readonly string[] {
	return linter
		.verify(
			code,
			[
				{
					files: ['**/*.ts'],
					languageOptions: { parser: ts.parser },
					plugins: { core: corePurityPlugin },
					rules: { 'core/purity': 'error' }
				}
			],
			'src/lib/core/planted.ts'
		)
		.map((m) => m.message);
}

describe('the core purity lint rule', () => {
	it.each([
		['Temporal.Now', 'export const x = Temporal.Now.instant();', 'Temporal'],
		['Temporal.Now, computed', "export const x = Temporal['Now'];", 'Temporal'],
		['Temporal as a value', 'export const T = Temporal;', 'Temporal'],
		['import.meta', 'export const x: unknown = import.meta.env;', 'import.meta'],
		['an Intl formatter', "export const x = new Intl.DateTimeFormat('en').format();", 'Intl'],
		['Intl as a value', 'export const I = Intl;', 'Intl'],
		['Date through an alias', 'const D = Date; export const x = new D();', 'Date'],
		['Reflect.construct', 'export const x: unknown = Reflect.construct(Date, []);', 'Reflect'],
		['Reflect.construct, computed', "export const x = Reflect['construct'];", 'Reflect'],
		['new Date with a spread', 'export const x = new Date(...[]);', 'Date'],
		['Date.parse', "export const x = Date.parse('2020');", 'Date'],
		['Date.now, computed', "export const x = Date['now']();", 'Date'],
		['Date.prototype', 'export const x = Date.prototype;', 'Date'],
		['toLocaleString', 'export const x = new Date(0).toLocaleString();', 'toLocaleString'],
		['localeCompare', "export const x = 'a'.localeCompare('b');", 'localeCompare'],
		['a local-time getter', 'export const x = new Date(0).getHours();', 'getHours'],
		['getTimezoneOffset', 'export const x = new Date(0).getTimezoneOffset();', 'getTimezoneOffset']
	])('reports %s', (_name, code, word) => {
		const found = problems(code);
		expect(found.length).toBeGreaterThan(0);
		expect(found.join('\n')).toContain(word);
	});

	it('allows the forms that read neither the clock nor the machine', () => {
		expect(
			problems(
				[
					'export const a = Date.UTC(2020, 0) + new Date(5).getUTCHours();',
					'export const b = (d: unknown): boolean => d instanceof Date;',
					'export const c = (d: Date): string => d.toISOString();',
					'export const d = Reflect.ownKeys({});',
					"export const e = Temporal.PlainDate.from('2020-01-01');",
					'export const f = (n: number): string => n.toString();',
					'export function g(Date: number): number { return Date; }'
				].join('\n')
			)
		).toEqual([]);
	});
});
