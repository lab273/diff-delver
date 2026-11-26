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
});
