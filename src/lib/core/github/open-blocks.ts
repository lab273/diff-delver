/**
 * Ending what an overall review left open, so what GitHub shows after it
 * in a posted review (the comments it cannot place, and the hidden mark)
 * is always drawn as meant: Markdown the reviewer typed is posted as typed,
 * and a code fence or an HTML block (CommonMark's kinds 1 to 5: `<pre>`,
 * `<script>`, `<style>` or `<textarea>`, a comment, `<?`, `<!X` and CDATA)
 * opened at its top level and never closed would swallow everything after
 * it, or hide it. Kinds 6 and 7, and paragraphs, quotes and lists, end at
 * the blank line that follows the overall review anyway.
 */

/** What is open at the end of a line. */
type Open =
	| { readonly kind: 'none' }
	| { readonly kind: 'fence'; readonly char: '`' | '~'; readonly length: number }
	| { readonly kind: 'html'; readonly end: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RAW_TEXT = /^ {0,3}<(pre|script|style|textarea)(?:\s|>|$)/i;

/** The HTML block a line starts, with the text that ends it, if it starts one. */
function htmlStart(line: string): string | undefined {
	const raw = RAW_TEXT.exec(line);
	if (raw !== null) return `</${(raw[1] ?? '').toLowerCase()}>`;
	const start = /^ {0,3}(<!--|<\?|<!\[CDATA\[|<![A-Za-z])/.exec(line)?.[1];
	switch (start) {
		case undefined:
			return undefined;
		case '<!--':
			return '-->';
		case '<?':
			return '?>';
		case '<![CDATA[':
			return ']]>';
		default:
			return '>';
	}
}

/** Where in `line` an HTML block's end could be found: after its start, for the line that starts it. */
function closes(line: string, end: string, from: number): boolean {
	return line.toLowerCase().indexOf(end, from) !== -1;
}

/**
 * What to put after `markdown`, on lines of its own, to end the code fence
 * or HTML block it leaves open: '' when it leaves none open.
 */
export function closingOpenBlocks(markdown: string): string {
	let open: Open = { kind: 'none' };
	for (const line of markdown.split(/\r\n|\n|\r/)) {
		switch (open.kind) {
			case 'fence': {
				const fence = FENCE.exec(line);
				const marks = fence?.[1] ?? '';
				if (
					fence !== null &&
					marks.startsWith(open.char) &&
					marks.length >= open.length &&
					(fence[2] ?? '').trim() === ''
				) {
					open = { kind: 'none' };
				}
				break;
			}
			case 'html':
				if (closes(line, open.end, 0)) open = { kind: 'none' };
				break;
			case 'none': {
				const fence = FENCE.exec(line);
				const marks = fence?.[1];
				if (fence !== null && marks !== undefined) {
					const char = marks.startsWith('`') ? '`' : '~';
					// A backtick fence's info string may not hold a backtick.
					if (char === '~' || !(fence[2] ?? '').includes('`')) {
						open = { kind: 'fence', char, length: marks.length };
					}
					break;
				}
				const end = htmlStart(line);
				if (end !== undefined && !closes(line, end, line.indexOf('<') + 2)) {
					open = { kind: 'html', end };
				}
				break;
			}
		}
	}
	switch (open.kind) {
		case 'none':
			return '';
		case 'fence':
			return open.char.repeat(open.length);
		case 'html':
			return open.end;
	}
}
