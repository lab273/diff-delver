/**
 * Which language a file is written in, for colouring its code (DESIGN 8.3):
 * from its name, or, for a file with no extension, from a `#!` line naming
 * its interpreter. A file in none of these is shown plain.
 *
 * To add a language, add its name here with the extensions (or interpreter)
 * that mean it, then its grammar to `GRAMMARS` in
 * `src/lib/server/highlight/highlighter.ts`, which lists one for each.
 */
import type { EscapedPath } from '../escaped-path.tiny.ts';
import type { LineText } from '../line-text.tiny.ts';
import type { RepoPath } from '../repo-path.tiny.ts';

export const LANGUAGES = [
	'c',
	'cpp',
	'csharp',
	'css',
	'diff',
	'docker',
	'go',
	'graphql',
	'html',
	'ini',
	'java',
	'javascript',
	'json',
	'jsonc',
	'jsx',
	'kotlin',
	'lua',
	'make',
	'markdown',
	'php',
	'python',
	'ruby',
	'rust',
	'scss',
	'shellscript',
	'sql',
	'svelte',
	'swift',
	'toml',
	'tsx',
	'typescript',
	'vue',
	'xml',
	'yaml'
] as const;

export type Language = (typeof LANGUAGES)[number];

/** By extension, lower case, without its dot. */
const BY_EXTENSION: ReadonlyMap<string, Language> = new Map<string, Language>([
	['c', 'c'],
	['h', 'c'],
	['cc', 'cpp'],
	['cpp', 'cpp'],
	['cxx', 'cpp'],
	['hh', 'cpp'],
	['hpp', 'cpp'],
	['hxx', 'cpp'],
	['cs', 'csharp'],
	['css', 'css'],
	['diff', 'diff'],
	['patch', 'diff'],
	['go', 'go'],
	['graphql', 'graphql'],
	['gql', 'graphql'],
	['html', 'html'],
	['htm', 'html'],
	['ini', 'ini'],
	['cfg', 'ini'],
	['java', 'java'],
	['js', 'javascript'],
	['mjs', 'javascript'],
	['cjs', 'javascript'],
	['json', 'json'],
	['jsonc', 'jsonc'],
	['jsx', 'jsx'],
	['kt', 'kotlin'],
	['kts', 'kotlin'],
	['lua', 'lua'],
	['mk', 'make'],
	['md', 'markdown'],
	['markdown', 'markdown'],
	['php', 'php'],
	['py', 'python'],
	['pyi', 'python'],
	['rb', 'ruby'],
	['rs', 'rust'],
	['scss', 'scss'],
	['sh', 'shellscript'],
	['bash', 'shellscript'],
	['zsh', 'shellscript'],
	['sql', 'sql'],
	['svelte', 'svelte'],
	['swift', 'swift'],
	['toml', 'toml'],
	['tsx', 'tsx'],
	['ts', 'typescript'],
	['mts', 'typescript'],
	['cts', 'typescript'],
	['vue', 'vue'],
	['xml', 'xml'],
	['svg', 'xml'],
	['yaml', 'yaml'],
	['yml', 'yaml']
]);

/** By the whole file name, lower case, for files whose name says what they are. */
const BY_NAME: ReadonlyMap<string, Language> = new Map<string, Language>([
	['dockerfile', 'docker'],
	['containerfile', 'docker'],
	['makefile', 'make'],
	['gnumakefile', 'make'],
	['gemfile', 'ruby'],
	['rakefile', 'ruby'],
	['.bashrc', 'shellscript'],
	['.zshrc', 'shellscript'],
	['.profile', 'shellscript'],
	['tsconfig.json', 'jsonc'],
	['jsconfig.json', 'jsonc']
]);

/** By the interpreter a `#!` line runs, for a file with no extension. */
const BY_INTERPRETER: ReadonlyMap<string, Language> = new Map<string, Language>([
	['sh', 'shellscript'],
	['bash', 'shellscript'],
	['zsh', 'shellscript'],
	['dash', 'shellscript'],
	['ksh', 'shellscript'],
	['node', 'javascript'],
	['deno', 'typescript'],
	['bun', 'javascript'],
	['python', 'python'],
	['python3', 'python'],
	['ruby', 'ruby'],
	['php', 'php'],
	['lua', 'lua']
]);

/** The interpreter a `#!` line names: `#!/bin/sh`, `#!/usr/bin/env -S node --flag`. */
function interpreterOf(line: LineText): string | undefined {
	if (!line.startsWith('#!')) return undefined;
	const words = line
		.slice(2)
		.trim()
		.split(/[ \t]+/);
	const first = words[0]?.split('/').at(-1);
	if (first !== 'env') return first;
	return words.slice(1).find((word) => !word.startsWith('-'));
}

/**
 * The language of a file named `path` (a path inside the repository, as git
 * gives it or in the escaped form the page holds, which keep the same name and
 * extension), given its first line when it is known; undefined when it is none
 * of `LANGUAGES`.
 */
export function languageOf(
	path: RepoPath | EscapedPath,
	firstLine?: LineText
): Language | undefined {
	const name = (path.split('/').at(-1) ?? '').toLowerCase();
	const byName = BY_NAME.get(name);
	if (byName !== undefined) return byName;
	const dot = name.lastIndexOf('.');
	if (dot > 0) return BY_EXTENSION.get(name.slice(dot + 1));
	if (firstLine === undefined) return undefined;
	const interpreter = interpreterOf(firstLine);
	if (interpreter === undefined) return undefined;
	return BY_INTERPRETER.get(interpreter.replace(/[0-9.]+$/, '')) ?? BY_INTERPRETER.get(interpreter);
}

/**
 * Whether a file named `path` could be coloured at all: its name says a
 * language, or it has no extension, so its first line may. The page asks for
 * no colours for any other file.
 */
export function couldBeColoured(path: RepoPath | EscapedPath): boolean {
	if (languageOf(path) !== undefined) return true;
	const name = path.split('/').at(-1) ?? '';
	return name.lastIndexOf('.') <= 0;
}
