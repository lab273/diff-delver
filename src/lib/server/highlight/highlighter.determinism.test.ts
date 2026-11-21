/**
 * Colours never depend on how long colouring took or on what was coloured
 * before: the first line coloured with a grammar, which pays for preparing
 * it, comes out as every later one does, and so does a file coloured while
 * the daemon is busy or before a language it embeds was ever seen.
 *
 * In a file of its own, so the highlighter here starts fresh, with no
 * grammar prepared.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGES, type Language } from '#lib/core/highlight/language.ts';
import { parseLineText, type LineText } from '#lib/core/line-text.tiny.ts';
import { colourLines } from './highlighter.ts';

function linesOf(...texts: string[]): readonly LineText[] {
	return texts.map((text) => {
		const parsed = parseLineText(text);
		if (!parsed.ok) throw new Error(text);
		return parsed.value;
	});
}

/** A first line for each language with something to colour in it. */
const FIRST_LINES: Readonly<Record<Language, string>> = {
	c: 'int main(void) { return printf("%d", 0); } // x',
	cpp: 'template <typename T> int f(T t) { return std::max<int>(0, t); } // x',
	csharp: 'public class A { public int F(string s) => s.Length; } // x',
	css: '.a > b:hover { color: #fff; margin: 0 auto; } /* x */',
	diff: '@@ -1,2 +1,3 @@ fn main()',
	docker: 'FROM node:26 AS build # x',
	go: 'func main() { fmt.Println("x", 1) } // x',
	graphql: 'query Q($id: ID!) { user(id: $id) { name } } # x',
	html: '<div class="a"><script>let a = 1;</script><style>b { color: red }</style></div>',
	ini: '[section] ; x',
	java: 'public static void main(String[] args) { System.out.println("x"); } // x',
	javascript: 'export const f = async (a, b = 1) => `x${a}` + /re/g.test(b); // x',
	json: '{ "a": [1, true, null, "x"] }',
	jsonc: '{ "a": 1 /* x */ } // y',
	jsx: 'const a = <div className="x" onClick={() => f(1)}>{b}</div>; // x',
	kotlin: 'fun main(args: Array<String>) { println("x" + 1) } // x',
	lua: 'local function f(a) return a .. "x" end -- x',
	make: 'all: build ; @echo "$(CC) x" # x',
	markdown: '# Title with `code` and [a link](https://example.com) and **bold**',
	php: '<?php function f($a) { return "x" . $a; } // x ?>',
	python: 'def f(a: int = 1) -> str: return f"x{a}"  # x',
	ruby: 'def f(a) = "x#{a}" if a.nil? # x',
	rust: 'fn main() -> Result<(), Box<dyn Error>> { println!("x {}", 1); Ok(()) } // x',
	scss: '$a: 1px; .b { &:hover { margin: $a * 2; } } // x',
	shellscript: 'for f in "$@"; do echo "${f%.x}" | grep -q y && exit 1; done # x',
	sql: "SELECT a, COUNT(*) FROM t WHERE b = 'x' GROUP BY a; -- x",
	svelte: '<script lang="ts">let a: number = 1;</script><p class:x={a}>{a}</p>',
	swift: 'func f(_ a: Int) -> String { return "x\\(a)" } // x',
	toml: '[a] b = "x" # y',
	tsx: 'const a: JSX.Element = <A<number> b={1 as number}>x</A>; // x',
	typescript:
		'export async function f<T extends object>(a: T): Promise<keyof T> { return "x"; } // x',
	vue: '<template><div :a="b" @click="c(1)">{{ d }}</div></template>',
	xml: '<?xml version="1.0"?><a b="x"><!-- y --><c/></a>',
	yaml: 'a: &b [1, "x", true] # y'
};

describe('colours that never depend on time or order', () => {
	it('colours a language embedded in another the same before that language is ever seen', async () => {
		const fenced = linesOf('```python', 'def f(): return "x"', '```');
		const before = await colourLines(fenced, 'markdown');
		await colourLines(linesOf('x = 1'), 'python');
		expect(await colourLines(fenced, 'markdown')).toEqual(before);
		expect(before[1]?.map((run) => run.kind)).toContain('keyword');
	});

	it('colours the first line with a freshly prepared grammar as it colours it later', async () => {
		for (const language of LANGUAGES) {
			const line = linesOf(FIRST_LINES[language]);
			const first = await colourLines(line, language);
			const second = await colourLines(line, language);
			expect({ language, runs: first }).toEqual({ language, runs: second });
		}
	});

	it('colours a file the same while the event loop is kept busy', async () => {
		const file = linesOf(
			...Array.from({ length: 400 }, (_, i) => FIRST_LINES.typescript.replace('f', `f${String(i)}`))
		);
		const quiet = await colourLines(file, 'typescript');
		let busy = true;
		const hog = (): void => {
			const until = performance.now() + 20;
			while (performance.now() < until) {
				// Keep the event loop from answering for a while.
			}
			if (busy) setImmediate(hog);
		};
		setImmediate(hog);
		try {
			expect(await colourLines(file, 'typescript')).toEqual(quiet);
		} finally {
			busy = false;
		}
	});
});
