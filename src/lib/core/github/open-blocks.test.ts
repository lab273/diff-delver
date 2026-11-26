import { describe, expect, it } from 'vitest';
import { closingOpenBlocks } from './open-blocks.ts';

describe('closingOpenBlocks', () => {
	it('leaves alone what ends everything it opens', () => {
		for (const closed of [
			'Plain words.',
			'```ts\nconst a = 1;\n```',
			'~~~~\ncode\n~~~~~',
			'<!-- a note -->\nAfter.',
			'<!--\nmany\nlines\n-->',
			'<pre>\nkept\n</PRE>',
			'<div>\nends at a blank line anyway',
			'Inline `<!--` and ``` in a line.',
			'    ```\n    indented code, not a fence'
		]) {
			expect(closingOpenBlocks(closed), closed).toBe('');
		}
	});

	it('ends a code fence left open, with as many of its marks', () => {
		expect(closingOpenBlocks('Look:\n```js\nlet x;')).toBe('```');
		expect(closingOpenBlocks('~~~~~\ncode')).toBe('~~~~~');
		// A shorter fence, or one with words after it, does not close it.
		expect(closingOpenBlocks('````\n```\n```` not a close')).toBe('````');
		// Nor does the other kind.
		expect(closingOpenBlocks('```\n~~~')).toBe('```');
	});

	it('ends an HTML comment or a block GitHub would run on to the end', () => {
		expect(closingOpenBlocks('Before.\n\n<!-- hidden from here')).toBe('-->');
		expect(closingOpenBlocks('<pre>\nall that follows')).toBe('</pre>');
		expect(closingOpenBlocks('<textarea>')).toBe('</textarea>');
		expect(closingOpenBlocks('<?php')).toBe('?>');
		expect(closingOpenBlocks('<![CDATA[ x')).toBe(']]>');
		expect(closingOpenBlocks('<!DOCTYPE html')).toBe('>');
	});

	it('does not read what is inside a fence as opening anything', () => {
		expect(closingOpenBlocks('```\n<!--\n```')).toBe('');
	});

	it('does not read a fence inside an HTML block that ends at a blank line as one', () => {
		for (const closed of [
			'<div>\n```\n</div>\n\n',
			'<div>\n```\n</div>\n\nmore text',
			'<div>\n```',
			'</table>\n~~~',
			'<DIV class="note">\n```',
			'<span class="x">\n```',
			'<my-tag/>\n```',
			'</em>\n```'
		]) {
			expect(closingOpenBlocks(closed), closed).toBe('');
		}
	});

	it('reads a fence after such a block’s blank line, or where no block starts, as one', () => {
		expect(closingOpenBlocks('<div>\n\n```\ncode')).toBe('```');
		expect(closingOpenBlocks('<div>\n```\n</div>\n\n```js\nlet x;')).toBe('```');
		// A whole tag alone on its line cannot interrupt a paragraph, so it starts no block.
		expect(closingOpenBlocks('Some text\n<span>\n```\ncode')).toBe('```');
		// Nor is a tag with words after it, or one not at the start of its line, a block of its own.
		expect(closingOpenBlocks('<span> words\n```')).toBe('```');
		expect(closingOpenBlocks('A <div>\n```')).toBe('```');
		// A name that only starts like a block-level one is not one.
		expect(closingOpenBlocks('Text\n<divider>\n```')).toBe('```');
	});
});
