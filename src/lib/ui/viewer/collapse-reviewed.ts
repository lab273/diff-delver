import type { PartIndex } from '#lib/core/part-index.tiny.ts';
import { whenReaderMoves } from './reader-input.ts';

/** Close the visible outgoing part while the page keeps it mounted. */
export function collapseReviewedPart(
	at: PartIndex,
	hidePart: boolean,
	stickyTop: number
): Animation | undefined {
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	const article = document.getElementById(`part-${at}`);
	const body = document.getElementById(`part-${at}-body`);
	const element = hidePart ? article : body;
	if (article === null || element === null) return;
	const box = element.getBoundingClientRect();
	if (box.height === 0 || box.bottom <= stickyTop || box.top >= window.innerHeight) return;

	const animation = element.animate(
		[
			{ boxSizing: 'border-box', height: `${box.height}px` },
			{
				boxSizing: 'border-box',
				height: '0px',
				...(hidePart ? { marginBottom: '0px', borderWidth: '0px' } : {})
			}
		],
		{ duration: 160, easing: 'ease-out', fill: 'forwards' }
	);
	if (hidePart) {
		// Clip the disappearing header and body together.
		element.style.overflow = 'clip';
		const reset = (): void => {
			element.style.removeProperty('overflow');
		};
		animation.addEventListener('cancel', reset, { once: true });
	}

	const header = article.querySelector('header');
	const start = article.getBoundingClientRect();
	if (header !== null && start.top < stickyTop && start.bottom > stickyTop) {
		// When already inside a long diff, follow its sticky header upward as the
		// bottom closes in. Keep the compact header at the reading edge.
		const height = header.getBoundingClientRect().height;
		let frame = requestAnimationFrame(keepHeader);
		const stop = whenReaderMoves(window, () => {
			cancelAnimationFrame(frame);
		});
		function keepHeader(): void {
			const bounds = article?.getBoundingClientRect();
			if (bounds === undefined) return;
			const shift = Math.min(stickyTop - bounds.top, stickyTop + height - bounds.bottom);
			if (shift > 0) window.scrollBy(0, -shift);
			if (animation.playState === 'running') frame = requestAnimationFrame(keepHeader);
		}
		const cleanup = (): void => {
			cancelAnimationFrame(frame);
			stop();
		};
		animation.addEventListener('cancel', cleanup, { once: true });
	}
	return animation;
}
