import { Marked } from 'marked';
import type { AgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';

function escapeHtml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const markdown = new Marked({
	async: false,
	renderer: {
		html: ({ text }) => escapeHtml(text),
		// Agent prose may describe links and images, but cannot send the browser
		// anywhere or request resources from the daemon or another host.
		link({ tokens }) {
			return this.parser.parseInline(tokens);
		},
		image: ({ text }) => escapeHtml(text),
		heading({ tokens }) {
			return `<p><strong>${this.parser.parseInline(tokens)}</strong></p>`;
		},
		checkbox: ({ checked }) => (checked ? '[x] ' : '[ ] ')
	}
});

/** The only HTML used for agent prose; raw HTML and resource URLs stay inert. */
export function renderAgentMarkdown(text: AgentMarkdown): string {
	try {
		return markdown.parse(text, { async: false });
	} catch {
		return `<p>${escapeHtml(text)}</p>`;
	}
}
