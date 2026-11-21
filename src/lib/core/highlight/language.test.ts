import { describe, expect, it } from 'vitest';
import { parseLineText, type LineText } from '../line-text.tiny.ts';
import { couldBeColoured, languageOf } from './language.ts';
import { tooMuchToColour } from './limits.ts';

function line(value: string): LineText {
	const parsed = parseLineText(value);
	if (!parsed.ok) throw new Error(value);
	return parsed.value;
}

describe('the language a file is written in', () => {
	it('is told by its extension, in any case', () => {
		expect(languageOf('src/app.ts')).toBe('typescript');
		expect(languageOf('src/App.TSX')).toBe('tsx');
		expect(languageOf('lib/x.py')).toBe('python');
		expect(languageOf('a/b/main.rs')).toBe('rust');
		expect(languageOf('styles/site.css')).toBe('css');
		expect(languageOf('config.yml')).toBe('yaml');
	});

	it('is told by a name that says what the file is', () => {
		expect(languageOf('Dockerfile')).toBe('docker');
		expect(languageOf('sub/Makefile')).toBe('make');
		expect(languageOf('tsconfig.json')).toBe('jsonc');
	});

	it('is told by the interpreter a #! line runs, when there is no extension', () => {
		expect(languageOf('scripts/build', line('#!/bin/sh'))).toBe('shellscript');
		expect(languageOf('bin/tool', line('#!/usr/bin/env -S node --no-warnings'))).toBe('javascript');
		expect(languageOf('bin/tool', line('#!/usr/bin/env python3.12'))).toBe('python');
		// An extension says more than a #! line.
		expect(languageOf('tool.rb', line('#!/bin/sh'))).toBe('ruby');
	});

	it('is none for anything else, which is shown plain', () => {
		expect(languageOf('notes/todo.txt')).toBeUndefined();
		expect(languageOf('data/prices.csv')).toBeUndefined();
		expect(languageOf('LICENSE')).toBeUndefined();
		expect(languageOf('bin/tool', line('just text'))).toBeUndefined();
		expect(languageOf('bin/tool', line('#!/opt/unknown'))).toBeUndefined();
	});
});

describe('whether a file could be coloured at all', () => {
	it('is so when its name says a language, or it has no extension for a #! line to say one', () => {
		expect(couldBeColoured('src/app.ts')).toBe(true);
		expect(couldBeColoured('bin/tool')).toBe(true);
		expect(couldBeColoured('.env')).toBe(true);
		expect(couldBeColoured('data/rows.txt')).toBe(false);
	});
});

describe('a file too much to colour', () => {
	it('is a large file, or one whose lines look minified', () => {
		expect(tooMuchToColour(2_000_000, 100)).toBe('large');
		expect(tooMuchToColour(100_000, 40_000)).toBe('large');
		expect(tooMuchToColour(50_000, 10)).toBe('minified');
		expect(tooMuchToColour(50_000, 2_000)).toBeUndefined();
		expect(tooMuchToColour(0, 0)).toBeUndefined();
	});
});
