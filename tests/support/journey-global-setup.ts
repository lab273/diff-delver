/**
 * Playwright global setup: prepares the journey browser's one system font, says
 * loudly when the run rewrites the committed screenshots instead of checking
 * them, and says once, in one line, when this machine is not the reference
 * platform and so the screenshots are not compared.
 */
import { screenshotMode, UPDATE_MODE_NOTICE } from '../../scripts/journey-screenshots.ts';
import { COMPARES_SCREENSHOTS } from './journey.ts';
import { prepareJourneyFonts } from './journey-fonts.ts';

export default function setup(): void {
	prepareJourneyFonts();
	if (screenshotMode(process.env) === 'update') console.log(UPDATE_MODE_NOTICE);
	if (!COMPARES_SCREENSHOTS) {
		console.log(
			`Notice: journey screenshots are compared only on Linux, the reference platform; this is ` +
				`${process.platform}, so every other check runs but the image comparison is skipped.`
		);
	}
}
