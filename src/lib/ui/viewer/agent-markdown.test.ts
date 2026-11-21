import { expect, it } from 'vitest';
import { parseAgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { renderAgentMarkdown } from './agent-markdown.ts';

it('formats agent prose without creating active HTML or resource requests', () => {
	const markdown = parseAgentMarkdown(
		[
			'**Review** the `price()` change.',
			'',
			'- Check the rounding.',
			'- Check the total.',
			'',
			'[same-origin](/api/settings) [script](javascript:alert%281%29) <https://example.com>',
			'',
			'![external image](https://example.com/image.png)',
			'',
			'<img src="/api/settings" onerror="alert(1)">'
		].join('\n')
	);
	if (!markdown.ok) throw new Error('The test text must be valid agent Markdown.');
	const rendered = renderAgentMarkdown(markdown.value);
	expect(rendered).toContain('<strong>Review</strong> the <code>price()</code> change.');
	expect(rendered).toContain('<li>Check the rounding.</li>');
	expect(rendered).toContain('same-origin script https://example.com');
	expect(rendered).toContain('external image');
	expect(rendered).toContain('&lt;img');
	expect(rendered).not.toMatch(/<(?:a|img|script)[\s>]/i);
	expect(rendered).not.toContain('image.png');
});
