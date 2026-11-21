/**
 * What the page says of changes it hides because they only change white space
 * (`core/viewer/white-space.ts`): how many of a part's own changes are hidden,
 * which the part says above its lines, and the same count for a hunk drawn
 * wholly as unchanged lines, which the hunk says in their place. Changes of
 * another group, drawn muted in the part, are not this part's, so neither
 * counts them.
 */
import type { ShownLineView } from '#lib/api/schemas.ts';
import type { Quieted } from '#lib/core/viewer/white-space.ts';

/** How many of a part's own changes the lines drawn show as unchanged lines. */
export function hiddenIn(drawn: readonly Quieted<ShownLineView>[]): number {
	return (
		drawn.filter(
			(d) => d.kind === 'quiet' && d.removed.kind !== 'context' && d.removed.home.kind === 'here'
		).length * 2
	);
}

/**
 * For a hunk whose every change is hidden and at least one of them this
 * part's, how many of the part's own changes it hides, said in place of its
 * lines; undefined when the hunk is drawn as it is.
 */
export function wholeHunkHidden(drawn: readonly Quieted<ShownLineView>[]): number | undefined {
	if (drawn.some((d) => d.kind === 'line' && d.line.kind !== 'context')) return undefined;
	const hidden = hiddenIn(drawn);
	return hidden > 0 ? hidden : undefined;
}
