/**
 * Colouring code by language (DESIGN 8.3), in the daemon, with Shiki: the
 * TextMate grammars editors such as VS Code use, run by Shiki's JavaScript
 * regular-expression engine, so nothing is loaded at run time, from the
 * network or as WebAssembly. Every grammar is bundled into the build.
 *
 * A file is coloured whole, one side at a time, so a line inside a block
 * comment or a template string is coloured as such even when the lines that
 * open it are not shown. The work is done a slice of lines at a time, with the
 * grammar's state carried from one slice to the next (which gives exactly the
 * colours of one pass), and the daemon answers other requests between slices.
 * A language's grammar is loaded the first time a file in it is coloured.
 *
 * Colours come from Shiki's CSS-variables theme, whose colour names are the
 * kinds of code it found; those are mapped to the page's few kinds
 * (`TokenKind`), and the page chooses the colours.
 */
import {
	createCssVariablesTheme,
	createHighlighterCoreSync,
	type GrammarState,
	type HighlighterCore,
	type LanguageRegistration,
	type ThemedToken
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import css from 'shiki/langs/css.mjs';
import diff from 'shiki/langs/diff.mjs';
import docker from 'shiki/langs/docker.mjs';
import go from 'shiki/langs/go.mjs';
import graphql from 'shiki/langs/graphql.mjs';
import html from 'shiki/langs/html.mjs';
import ini from 'shiki/langs/ini.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsonc from 'shiki/langs/jsonc.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import lua from 'shiki/langs/lua.mjs';
import make from 'shiki/langs/make.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import php from 'shiki/langs/php.mjs';
import python from 'shiki/langs/python.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import rust from 'shiki/langs/rust.mjs';
import scss from 'shiki/langs/scss.mjs';
import shellscript from 'shiki/langs/shellscript.mjs';
import sql from 'shiki/langs/sql.mjs';
import svelte from 'shiki/langs/svelte.mjs';
import swift from 'shiki/langs/swift.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import vue from 'shiki/langs/vue.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import { characterCount } from '#lib/core/character-count.tiny.ts';
import type { ColourRun, TokenKind } from '#lib/core/highlight/colour-run.ts';
import type { Language } from '#lib/core/highlight/language.ts';
import { LONGEST_LINE_TO_COLOUR } from '#lib/core/highlight/limits.ts';
import type { LineText } from '#lib/core/line-text.tiny.ts';

/** The grammar of each language `languageOf` names, with the grammars it embeds. */
const GRAMMARS: Readonly<Record<Language, readonly LanguageRegistration[]>> = {
	c,
	cpp,
	csharp,
	css,
	diff,
	docker,
	go,
	graphql,
	html,
	ini,
	java,
	javascript,
	json,
	jsonc,
	jsx,
	kotlin,
	lua,
	make,
	markdown,
	php,
	python,
	ruby,
	rust,
	scss,
	shellscript,
	sql,
	svelte,
	swift,
	toml,
	tsx,
	typescript,
	vue,
	xml,
	yaml
};

const THEME = 'diff-delver';
const PREFIX = '--diff-delver-';

/** The theme's colour names that are a kind the page colours; any other is plain. */
const KINDS: ReadonlyMap<string, TokenKind> = new Map<string, TokenKind>([
	[`var(${PREFIX}token-keyword)`, 'keyword'],
	[`var(${PREFIX}token-string)`, 'string'],
	[`var(${PREFIX}token-string-expression)`, 'string'],
	[`var(${PREFIX}token-link)`, 'string'],
	[`var(${PREFIX}token-comment)`, 'comment'],
	[`var(${PREFIX}token-function)`, 'function'],
	[`var(${PREFIX}token-constant)`, 'constant'],
	[`var(${PREFIX}token-parameter)`, 'parameter']
]);

/**
 * How long one slice of colouring may take, about, before the daemon turns to
 * other work: each slice is made longer or shorter to keep near it, so the
 * daemon keeps answering while a large file is coloured. Where the slices
 * fall changes nothing in the colours.
 */
const SLICE_MS = 10;
const FIRST_SLICE_LINES = 16;
const MOST_SLICE_LINES = 2_000;

let shared: HighlighterCore | undefined;
const loaded = new Set<Language>();

/**
 * The highlighter, made on first use with no grammar; each language's grammar
 * is loaded when a file in it is first coloured, so the daemon only ever
 * prepares the grammars of the files it is shown.
 */
function highlighterFor(language: Language): HighlighterCore {
	shared ??= createHighlighterCoreSync({
		themes: [createCssVariablesTheme({ name: THEME, variablePrefix: PREFIX, fontStyle: false })],
		langs: [],
		engine: createJavaScriptRegexEngine()
	});
	if (!loaded.has(language)) {
		shared.loadLanguageSync(...GRAMMARS[language]);
		loaded.add(language);
	}
	return shared;
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** One line's tokens as runs of colour, neighbours of one kind joined. */
function runsOf(tokens: readonly ThemedToken[], lineStart: number): readonly ColourRun[] {
	const runs: ColourRun[] = [];
	for (const token of tokens) {
		const kind = KINDS.get(token.color ?? '');
		if (kind === undefined || token.content.length === 0) continue;
		const start = token.offset - lineStart;
		const last = runs.at(-1);
		if (last !== undefined && last.kind === kind && last.start + last.length === start) {
			runs[runs.length - 1] = {
				...last,
				length: characterCount(last.length + token.content.length)
			};
		} else {
			runs.push({
				start: characterCount(start),
				length: characterCount(token.content.length),
				kind
			});
		}
	}
	return runs;
}

/**
 * The colours of a whole file's lines, in `language`: for each line, its runs
 * of colour in order. A carriage return at the end of a line is left out of
 * what is coloured, so a file with CRLF endings is coloured as any other.
 */
export async function colourLines(
	lines: readonly LineText[],
	language: Language
): Promise<readonly (readonly ColourRun[])[]> {
	const shiki = highlighterFor(language);
	// Each list ends with the language itself, after the grammars it embeds.
	const grammar = GRAMMARS[language].at(-1)?.name ?? language;
	const coloured: (readonly ColourRun[])[] = [];
	let state: GrammarState | undefined;
	let size = FIRST_SLICE_LINES;
	for (let first = 0; first < lines.length;) {
		if (first > 0) await nextTurn();
		const started = performance.now();
		const slice = lines
			.slice(first, first + size)
			.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
		const tokens = shiki.codeToTokensBase(slice.join('\n'), {
			lang: grammar,
			theme: THEME,
			tokenizeMaxLineLength: LONGEST_LINE_TO_COLOUR,
			...(state === undefined ? {} : { grammarState: state })
		});
		state = shiki.getLastGrammarState(tokens);
		let lineStart = 0;
		for (const [i, line] of slice.entries()) {
			coloured.push(runsOf(tokens[i] ?? [], lineStart));
			lineStart += line.length + 1;
		}
		first += slice.length;
		const took = performance.now() - started;
		if (took < SLICE_MS / 2) size = Math.min(MOST_SLICE_LINES, size * 2);
		else if (took > SLICE_MS * 2) size = Math.max(1, Math.floor(size / 2));
	}
	return coloured;
}
