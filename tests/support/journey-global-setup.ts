/**
 * Playwright global setup: prepares the journey browser's one system font, and
 * says once, in one line, when this machine is not the reference platform and so
 * the screenshots are not compared.
 */
import { COMPARES_SCREENSHOTS } from './journey.ts';
import { prepareJourneyFonts } from './journey-fonts.ts';

export default function setup(): void {
	prepareJourneyFonts();
	if (!COMPARES_SCREENSHOTS) {
		console.log(
			`Notice: journey screenshots are compared only on Linux, the reference platform; this is ` +
				`${process.platform}, so every other check runs but the image comparison is skipped.`
		);
	}
}
