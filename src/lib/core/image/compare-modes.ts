/**
 * The ways a changed image is compared (DESIGN 8.4), in the order the page
 * offers them and the `i` key steps through them: the two side by side; one
 * over the other with a slider between them; the new one over the old,
 * see-through; and the pixels that differ, marked.
 */

export const COMPARE_MODES = ['side-by-side', 'slider', 'onion-skin', 'pixel-difference'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

/** The mode's name, as its button shows it. */
export function compareModeName(mode: CompareMode): string {
	switch (mode) {
		case 'side-by-side':
			return 'Side by side';
		case 'slider':
			return 'Slider';
		case 'onion-skin':
			return 'Onion skin';
		case 'pixel-difference':
			return 'Pixel difference';
	}
}

/** The mode after this one, back to the first after the last. */
export function nextCompareMode(mode: CompareMode): CompareMode {
	const at = COMPARE_MODES.indexOf(mode);
	return COMPARE_MODES[(at + 1) % COMPARE_MODES.length] ?? 'side-by-side';
}
