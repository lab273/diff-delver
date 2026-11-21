import { describe, expect, expectTypeOf, it } from 'vitest';
import { parseByteSize, type ByteSize } from '../byte-size.tiny.ts';
import type { EscapedPath } from '../escaped-path.tiny.ts';
import { lineCountOf, type LineCount } from '../line-count.tiny.ts';
import { parseLineText, type LineText } from '../line-text.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { couldBeColoured, languageOf } from './language.ts';
import { tooMuchToColour } from './limits.ts';

function path(value: string): RepoPath {
	const parsed = parseRepoPath(value);
	if (!parsed.ok) throw new Error(value);
	return parsed.value;
}

function size(value: number): ByteSize {
	const parsed = parseByteSize(value);
	if (!parsed.ok) throw new Error(String(value));
	return parsed.value;
}

function line(value: string): LineText {
	const parsed = parseLineText(value);
	if (!parsed.ok) throw new Error(value);
	return parsed.value;
}

describe('the language a file is written in', () => {
	it('is told by its extension, in any case', () => {
		expect(languageOf(path('src/app.ts'))).toBe('typescript');
		expect(languageOf(path('src/App.TSX'))).toBe('tsx');
		expect(languageOf(path('lib/x.py'))).toBe('python');
		expect(languageOf(path('a/b/main.rs'))).toBe('rust');
		expect(languageOf(path('styles/site.css'))).toBe('css');
		expect(languageOf(path('config.yml'))).toBe('yaml');
	});

	it('is told by a name that says what the file is', () => {
		expect(languageOf(path('Dockerfile'))).toBe('docker');
		expect(languageOf(path('sub/Makefile'))).toBe('make');
		expect(languageOf(path('tsconfig.json'))).toBe('jsonc');
	});

	it('is told by the interpreter a #! line runs, when there is no extension', () => {
		expect(languageOf(path('scripts/build'), line('#!/bin/sh'))).toBe('shellscript');
		expect(languageOf(path('bin/tool'), line('#!/usr/bin/env -S node --no-warnings'))).toBe(
			'javascript'
		);
		expect(languageOf(path('bin/tool'), line('#!/usr/bin/env python3.12'))).toBe('python');
		// An extension says more than a #! line.
		expect(languageOf(path('tool.rb'), line('#!/bin/sh'))).toBe('ruby');
	});

	it('is none for anything else, which is shown plain', () => {
		expect(languageOf(path('notes/todo.txt'))).toBeUndefined();
		expect(languageOf(path('data/prices.csv'))).toBeUndefined();
		expect(languageOf(path('LICENSE'))).toBeUndefined();
		expect(languageOf(path('bin/tool'), line('just text'))).toBeUndefined();
		expect(languageOf(path('bin/tool'), line('#!/opt/unknown'))).toBeUndefined();
	});
});

describe('whether a file could be coloured at all', () => {
	it('is so when its name says a language, or it has no extension for a #! line to say one', () => {
		expect(couldBeColoured(path('src/app.ts'))).toBe(true);
		expect(couldBeColoured(path('bin/tool'))).toBe(true);
		expect(couldBeColoured(path('.env'))).toBe(true);
		expect(couldBeColoured(path('data/rows.txt'))).toBe(false);
	});
});

describe('a file too much to colour', () => {
	it('is a large file, or one whose lines look minified', () => {
		expect(tooMuchToColour(size(2_000_000), lineCountOf(100))).toBe('large');
		expect(tooMuchToColour(size(100_000), lineCountOf(40_000))).toBe('large');
		expect(tooMuchToColour(size(50_000), lineCountOf(10))).toBe('minified');
		expect(tooMuchToColour(size(50_000), lineCountOf(2_000))).toBeUndefined();
		expect(tooMuchToColour(size(0), lineCountOf(0))).toBeUndefined();
	});
});

describe('what the language rules take', () => {
	it('take a path, a size and a count of lines, not bare text and numbers', () => {
		expectTypeOf(languageOf).parameter(0).toEqualTypeOf<RepoPath | EscapedPath>();
		expectTypeOf(couldBeColoured).parameter(0).toEqualTypeOf<RepoPath | EscapedPath>();
		expectTypeOf(tooMuchToColour).parameters.toEqualTypeOf<[ByteSize, LineCount]>();
		expect(couldBeColoured(path('a.ts'))).toBe(true);
	});
});
