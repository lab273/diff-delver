/**
 * A repository of changed images (DESIGN 8.4), built by real git, for the
 * image route's tests and journey J13: a PNG changed in place, one whose size
 * changed, one added and one deleted, and an SVG changed, uncommitted on top
 * of a commit that has the earlier ones.
 */
import { drawn, encodePng, type Colour } from './png.ts';
import type { GitRepo } from './git-repo.ts';

const SKY: Colour = [74, 144, 226, 255];
const WHITE: Colour = [255, 255, 255, 255];
const GOLD: Colour = [245, 190, 40, 255];
const INK: Colour = [40, 44, 52, 255];
const GREEN: Colour = [60, 170, 90, 255];
const CLEAR: Colour = [0, 0, 0, 0];

/** The badge before: a white card on the sky with a gold sun. 48 × 32 pixels. */
export const BADGE_BEFORE = encodePng(
	drawn(48, 32, SKY, [
		{ x: 4, y: 4, width: 22, height: 24, colour: WHITE },
		{ x: 34, y: 6, width: 8, height: 8, colour: GOLD }
	])
);

/** The badge after: the sun moved down and a line of ink written on the card. 48 × 32 pixels. */
export const BADGE_AFTER = encodePng(
	drawn(48, 32, SKY, [
		{ x: 4, y: 4, width: 22, height: 24, colour: WHITE },
		{ x: 8, y: 14, width: 14, height: 3, colour: INK },
		{ x: 34, y: 18, width: 8, height: 8, colour: GOLD }
	])
);

/** How many of the badge's pixels changed: the sun's old and new places, and the ink. */
export const BADGE_PIXELS_CHANGED = 8 * 8 * 2 + 14 * 3;

const BANNER_BEFORE = encodePng(
	drawn(40, 16, GREEN, [{ x: 2, y: 2, width: 12, height: 12, colour: WHITE }])
);
const BANNER_AFTER = encodePng(
	drawn(64, 24, GREEN, [{ x: 2, y: 2, width: 12, height: 12, colour: WHITE }])
);
const NEW_ICON = encodePng(
	drawn(16, 16, CLEAR, [
		{ x: 2, y: 2, width: 12, height: 12, colour: GOLD },
		{ x: 6, y: 6, width: 4, height: 4, colour: INK }
	])
);
const OLD_ICON = encodePng(
	drawn(16, 16, INK, [{ x: 4, y: 4, width: 8, height: 8, colour: WHITE }])
);

const svg = (fill: string): string =>
	[
		'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
		'  <rect width="32" height="32" rx="6" fill="#2c3e50"/>',
		`  <circle cx="16" cy="16" r="9" fill="${fill}"/>`,
		'</svg>',
		''
	].join('\n');

export async function buildImages(repo: GitRepo): Promise<void> {
	await repo.write('assets/badge.png', BADGE_BEFORE);
	await repo.write('assets/banner.png', BANNER_BEFORE);
	await repo.write('assets/old-icon.png', OLD_ICON);
	await repo.write('assets/logo.svg', svg('#e74c3c'));
	await repo.commit('Add the images');
	await repo.write('assets/badge.png', BADGE_AFTER);
	await repo.write('assets/banner.png', BANNER_AFTER);
	await repo.write('assets/new-icon.png', NEW_ICON);
	await repo.remove('assets/old-icon.png');
	await repo.write('assets/logo.svg', svg('#27ae60'));
}
