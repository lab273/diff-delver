/**
 * The documents point at things that exist (docs/DEVELOPING.md, at its top): every
 * link from a document to a file or a heading of the repository finds one, the
 * README's pictures are journey screenshots in both themes, so they change with the
 * interface, and CLAUDE.md and AGENTS.md are links to the developer guidance.
 */
import { existsSync } from 'node:fs';
import { readFile, readlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DOCUMENTS = [
	'README.md',
	'docs/DESIGN.md',
	'docs/DEVELOPING.md',
	'tests/agent-trials/README.md'
];
const SCREENSHOTS = 'tests/journeys/screenshots/';

/** A document without its code, where a bracket or a `#` is not a link or a heading. */
function prose(markdown: string): string {
	return markdown.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
}

/** What a document links to or shows: Markdown links and images, and HTML `src` and `srcset`. */
function targets(markdown: string): string[] {
	const text = prose(markdown);
	const found = [
		...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ''),
		...[...text.matchAll(/\s(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1] ?? '')
	];
	return found.filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));
}

/** The address GitHub gives each heading of a document. */
function headingAnchors(markdown: string): Set<string> {
	const anchors = new Set<string>();
	// A heading keeps the words of its inline code, so only fenced code is taken out.
	const text = markdown.replace(/^```[\s\S]*?^```/gm, '');
	for (const match of text.matchAll(/^#{1,6} +(.+?) *$/gm)) {
		const words = (match[1] ?? '')
			.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
			.toLowerCase()
			.replace(/[^\p{L}\p{N} _-]/gu, '')
			.replaceAll(' ', '-');
		let anchor = words;
		for (let n = 1; anchors.has(anchor); n += 1) anchor = `${words}-${String(n)}`;
		anchors.add(anchor);
	}
	return anchors;
}

async function read(path: string): Promise<string> {
	return readFile(join(ROOT, path), 'utf8');
}

describe('the documents', () => {
	it.each(DOCUMENTS)('%s links only to files and headings that exist', async (document) => {
		const broken: string[] = [];
		for (const target of targets(await read(document))) {
			const [file = '', anchor] = target.split('#');
			const path = file === '' ? document : relative(ROOT, resolve(ROOT, dirname(document), file));
			if (path.startsWith('..') || !existsSync(join(ROOT, path))) {
				broken.push(`${target}: no such file`);
			} else if (anchor !== undefined && path.endsWith('.md')) {
				if (!headingAnchors(await read(path)).has(anchor)) {
					broken.push(`${target}: no such heading in ${path}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it('shows only journey screenshots in the README, each in both themes', async () => {
		const pictures = targets(await read('README.md')).filter((target) => target.endsWith('.png'));
		expect(pictures.length).toBeGreaterThan(0);
		expect(pictures.filter((picture) => !picture.startsWith(SCREENSHOTS))).toEqual([]);
		const steps = (theme: string): string[] =>
			pictures
				.filter((picture) => picture.endsWith(`.${theme}.png`))
				.map((picture) => picture.slice(0, -`.${theme}.png`.length))
				.sort();
		expect(steps('light').length + steps('dark').length).toBe(pictures.length);
		expect(steps('dark')).toEqual(steps('light'));
	});

	it('keeps the heading the command sends people to for upgrading', async () => {
		// src/lib/core/cli/replaced-daemon.ts prints this address.
		expect(headingAnchors(await read('README.md')).has('upgrading')).toBe(true);
	});

	it.each(['CLAUDE.md', 'AGENTS.md'])('%s is a link to the developer guidance', async (name) => {
		expect(await readlink(join(ROOT, name))).toBe('docs/DEVELOPING.md');
	});
});
