/**
 * Ending what an overall review left open, so what GitHub shows after it
 * in a posted review (the comments it cannot place, and the hidden mark)
 * is always drawn as meant: Markdown the reviewer typed is posted as typed,
 * and a code fence or an HTML block (CommonMark's kinds 1 to 5: `<pre>`,
 * `<script>`, `<style>` or `<textarea>`, a comment, `<?`, `<!X` and CDATA)
 * opened at its top level and never closed would swallow everything after
 * it, or hide it. Kinds 6 and 7 (a block-level tag such as `<div>`, or a
 * whole tag alone on its line) end at the blank line that follows the
 * overall review anyway, as paragraphs, quotes and lists do, but are
 * followed to that line, since a fence inside one is not a fence.
 */

/** What is open at the end of a line. */
type Open =
	| { readonly kind: 'none' }
	| { readonly kind: 'fence'; readonly char: '`' | '~'; readonly length: number }
	| { readonly kind: 'html'; readonly end: string }
	/** An HTML block of kind 6 or 7, which ends at the next blank line. */
	| { readonly kind: 'html-to-blank' };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RAW_TEXT = /^ {0,3}<(pre|script|style|textarea)(?:\s|>|$)/i;

/** CommonMark's kind 6: the block-level tags, whose blocks start with one, opening or closing. */
const BLOCK_TAG_NAMES = [
	'address article aside base basefont blockquote body caption center col colgroup dd details',
	'dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6',
	'head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option',
	'p param search section summary table tbody td tfoot th thead title tr track ul'
]
	.join(' ')
	.split(' ');

const BLOCK_TAG = new RegExp(
	String.raw`^ {0,3}</?(?:${BLOCK_TAG_NAMES.join('|')})(?:[ \t>]|/>|$)`,
	'i'
);

const ATTRIBUTE = String.raw`\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?`;

/** CommonMark's kind 7: a whole open or closing tag, and nothing else, on its line. */
const WHOLE_TAG = new RegExp(
	String.raw`^ {0,3}(?:<(?!(?:pre|script|style|textarea)\b)[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>)\s*$`,
	'i'
);

const isBlank = (line: string): boolean => line.trim() === '';

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
	/** Whether the line before is in a paragraph, which a kind-7 tag cannot interrupt. */
	let paragraph = false;
	for (const line of markdown.split(/\r\n|\n|\r/)) {
		const after = paragraph;
		paragraph = false;
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
			case 'html-to-blank':
				if (isBlank(line)) open = { kind: 'none' };
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
				if (end !== undefined) {
					if (!closes(line, end, line.indexOf('<') + 2)) open = { kind: 'html', end };
					break;
				}
				if (BLOCK_TAG.test(line) || (!after && WHOLE_TAG.test(line))) {
					open = { kind: 'html-to-blank' };
					break;
				}
				// Any other line that is not blank is a paragraph's, or as good as one here.
				paragraph = !isBlank(line);
				break;
			}
		}
	}
	switch (open.kind) {
		case 'none':
		case 'html-to-blank':
			return '';
		case 'fence':
			return open.char.repeat(open.length);
		case 'html':
			return open.end;
	}
}
