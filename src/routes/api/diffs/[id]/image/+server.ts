import { ImageQuerySchema } from '#lib/api/schemas.ts';
import { contentTypeOf } from '#lib/core/image/image-format.ts';
import { resolveEscapedPath } from '#lib/core/path-bytes.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readQuery, unknownPath } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * One side of an image of the version the page shows, as it is, from diff
 * delver's copy of the diff (DESIGN 8.4), for the page's `<img>`. The bytes
 * are served with the content type they have, never sniffed for another,
 * and in a sandbox where nothing runs and nothing loads from elsewhere: an
 * SVG opened by its address runs no script and fetches nothing, as when it is
 * drawn by `<img>`, and draws the images and fonts it holds within itself.
 * The version's files never change, so the browser may keep it a while.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const query = readQuery(url, ImageQuerySchema);
	if (!query.ok) return query.error;
	const { version, side, path } = query.value;
	const repoPath = resolveEscapedPath(path);
	if (repoPath === undefined) return unknownPath();
	const image = await locals.daemon.service.readImage(id.value, version, side, repoPath);
	if (!image.ok) return serviceFailure(image.error);
	return new Response(Buffer.from(image.value.bytes), {
		headers: {
			'Content-Type': contentTypeOf(image.value.format),
			'Content-Length': String(image.value.bytes.byteLength),
			'Content-Security-Policy':
				"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'private, max-age=3600'
		}
	});
};
