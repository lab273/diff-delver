/**
 * Images through the daemon (DESIGN 8.4): what a part says of each side of an
 * image, and the image route that serves a side's bytes from the snapshot
 * store, with the content type its bytes have, in a sandbox, to a browser let
 * in as for reading a part, and refused in plain words otherwise.
 */
import { describe, expect, it } from 'vitest';
import type { PartQuery } from '#lib/api/schemas.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { MAX_IMAGE_SIZE } from '#lib/core/image/image-format.ts';
import {
	browserCookie,
	clientOf,
	rawRequest,
	testDaemon
} from '../../../../tests/support/daemons.ts';
import { defineFixture, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import {
	BADGE_AFTER,
	BADGE_BEFORE,
	buildImages,
	STAMP,
	svg
} from '../../../../tests/support/image-fixtures.ts';

const images = defineFixture('images', buildImages);

/**
 * A file named as a PNG past the largest image shown, a binary file named as
 * one that is not, and an image whose name is not UTF-8.
 */
const odd = defineFixture('odd-images', async (repo) => {
	await repo.write('notes.txt', 'start\n');
	await repo.commit('Start');
	const large = new Uint8Array(MAX_IMAGE_SIZE + 1);
	large.set(BADGE_BEFORE.subarray(0, 8));
	await repo.write('huge.png', large);
	await repo.write('fake.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
	// A name that is not UTF-8: "caf" and the byte E9.
	await repo.writeRaw(Buffer.from('caf\xe9.png', 'latin1'), BADGE_BEFORE);
});

/** 4 KiB of bytes git calls binary, the same each run. */
const BLOB = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) % 251);

/**
 * Files an image on one side only: one renamed to a name that is not an
 * image's, one replaced by bytes that are not a PNG, and a text file renamed
 * to be an SVG; and a binary file renamed and changed a little.
 */
const halves = defineFixture('half-images', async (repo) => {
	await repo.write('logo.png', BADGE_BEFORE);
	await repo.write('broken.png', BADGE_AFTER);
	await repo.write('data.txt', svg('#123456'));
	await repo.write('kept.bin', BLOB);
	await repo.commit('Start');
	await repo.remove('kept.bin');
	await repo.write(
		'kept.dat',
		Uint8Array.from(BLOB, (byte, i) => (i === 100 ? 7 : byte))
	);
	await repo.move('logo.png', 'logo.bin');
	await repo.write('broken.png', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
	await repo.move('data.txt', 'data.svg');
});

const path = (text: string) => escapedRepoPath(value(parseRepoPath(text)));
const version = value(parseRevisionNumber(1));

async function opened(fixture: typeof images) {
	const repo = await useFixture(fixture);
	const daemon = await testDaemon();
	const client = clientOf(daemon);
	const started = value(await client.start({ directory: repo.dir }));
	if (started.kind !== 'opened') throw new Error(started.kind);
	const id = started.diff.id;
	const page = value(await client.loadDiff(id));
	const part = (file: string): PartQuery => ({
		version,
		assignments: page.assignments,
		view: 'sections',
		group: { kind: 'uncategorised' },
		path: path(file)
	});
	return { repo, daemon, client, id, part };
}

describe('images', () => {
	it('are described side by side in a part and served from the store', async () => {
		const { daemon, client, id, part } = await opened(images);
		const badge = value(await client.readPart(id, part('assets/badge.png')));
		expect(badge.image).toEqual({
			old: { kind: 'image', format: 'png', size: BADGE_BEFORE.byteLength },
			new: { kind: 'image', format: 'png', size: BADGE_AFTER.byteLength },
			sameBytes: false
		});
		// An added image has only its new side, a deleted one only its old.
		expect(value(await client.readPart(id, part('assets/new-icon.png'))).image).toMatchObject({
			old: null,
			new: { kind: 'image', format: 'png' }
		});
		expect(value(await client.readPart(id, part('assets/old-icon.png'))).image).toMatchObject({
			old: { kind: 'image', format: 'png' },
			new: null
		});
		// An SVG is a picture and keeps its lines.
		const logo = value(await client.readPart(id, part('assets/logo.svg')));
		expect(logo.image).toMatchObject({
			old: { kind: 'image', format: 'svg' },
			new: { kind: 'image', format: 'svg' }
		});
		expect(logo.blocks.length).toBeGreaterThan(0);
		// A renamed image has both sides, each read by its own path, with the same bytes.
		expect(value(await client.readPart(id, part('assets/seal.png'))).image).toEqual({
			old: { kind: 'image', format: 'png', size: STAMP.byteLength },
			new: { kind: 'image', format: 'png', size: STAMP.byteLength },
			sameBytes: true
		});
		expect(badge.image?.sameBytes).toBe(false);

		const cookie = await browserCookie(daemon);
		const read = (query: string) =>
			fetch(`${daemon.origin}/api/diffs/${id}/image?${query}`, { headers: { cookie } });
		const before = await read('version=1&side=old&path=assets/badge.png');
		expect(before.status).toBe(200);
		expect(before.headers.get('content-type')).toBe('image/png');
		expect(before.headers.get('x-content-type-options')).toBe('nosniff');
		expect(before.headers.get('content-security-policy')).toContain('sandbox');
		expect(new Uint8Array(await before.arrayBuffer())).toEqual(BADGE_BEFORE);
		const after = await read('version=1&side=new&path=assets/badge.png');
		expect(new Uint8Array(await after.arrayBuffer())).toEqual(BADGE_AFTER);
		const svg = await read('version=1&side=new&path=assets/logo.svg');
		expect(svg.headers.get('content-type')).toBe('image/svg+xml');
		expect(svg.headers.get('content-security-policy')).toBe(
			"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox"
		);
		expect(await svg.text()).toContain('#27ae60');

		// A side the file does not have, and a file that is no image, are said plainly.
		const gone = await read('version=1&side=new&path=assets/old-icon.png');
		expect(gone.status).toBe(404);
		expect(await gone.text()).toContain('assets/old-icon.png does not exist in the new version');

		// Read as a part is read: not without being let in.
		const stranger = await rawRequest(daemon.port, {
			path: `/api/diffs/${id}/image?version=1&side=old&path=assets/badge.png`
		});
		expect(stranger.status).toBe(403);
	});

	it('say when a file is too large to show or is not an image after all', async () => {
		const { daemon, client, id, part } = await opened(odd);
		const huge = value(await client.readPart(id, part('huge.png')));
		expect(huge.image).toEqual({
			old: null,
			new: { kind: 'too-large', format: 'png', size: MAX_IMAGE_SIZE + 1 },
			sameBytes: false
		});
		// Its name says PNG, its bytes do not: it is a binary file and no picture.
		const fake = value(await client.readPart(id, part('fake.png')));
		expect(fake.image).toBeNull();
		expect(fake.sizes).toEqual({ old: null, new: 8 });

		const auth = { authorization: `Bearer ${daemon.token}` };
		const tooLarge = await rawRequest(daemon.port, {
			path: `/api/diffs/${id}/image?version=1&side=new&path=huge.png`,
			headers: auth
		});
		expect(tooLarge.status).toBe(422);
		expect(tooLarge.body).toContain(
			'huge.png in the new version is too large to show as a picture: 16,777,217 bytes, and diff delver shows images of up to 16,777,216 bytes.'
		);
		const notImage = await rawRequest(daemon.port, {
			path: `/api/diffs/${id}/image?version=1&side=new&path=fake.png`,
			headers: auth
		});
		expect(notImage.status).toBe(422);
		expect(notImage.body).toContain('fake.png in the new version is not an image');
		// A name that is not UTF-8 is asked for by its escaped form, and served.
		const escaped = path('caf\udce9.png');
		expect(escaped).toBe(String.raw`caf\xE9.png`);
		expect(value(await client.readPart(id, part('caf\udce9.png'))).image).toMatchObject({
			new: { kind: 'image', format: 'png' }
		});
		const query = new URLSearchParams({ version: '1', side: 'new', path: escaped });
		const served = await rawRequest(daemon.port, {
			path: `/api/diffs/${id}/image?${query.toString()}`,
			headers: auth
		});
		expect(served.status).toBe(200);
		const text = await rawRequest(daemon.port, {
			path: `/api/diffs/${id}/image?version=1&side=new&path=notes.txt`,
			headers: auth
		});
		expect(text.status).toBe(422);
	});

	it('say what a side that is no picture is, beside one that is', async () => {
		const { daemon, client, id, part } = await opened(halves);
		// Renamed to a name that is not an image's: still changed, not deleted, with each side's size.
		const renamed = value(await client.readPart(id, part('logo.bin')));
		expect(renamed.image).toEqual({
			old: { kind: 'image', format: 'png', size: BADGE_BEFORE.byteLength },
			new: { kind: 'other', what: 'binary', size: BADGE_BEFORE.byteLength },
			sameBytes: true
		});
		// A binary file renamed and changed is measured by each side's own path.
		const moved = value(await client.readPart(id, part('kept.dat')));
		expect(moved.image).toBeNull();
		expect(moved.sizes).toEqual({ old: 4096, new: 4096 });
		// Replaced by bytes that are no PNG.
		expect(value(await client.readPart(id, part('broken.png'))).image).toEqual({
			old: { kind: 'image', format: 'png', size: BADGE_AFTER.byteLength },
			new: { kind: 'other', what: 'binary', size: 10 },
			sameBytes: false
		});
		// A text file that became an SVG keeps its lines.
		const data = value(await client.readPart(id, part('data.svg')));
		expect(data.image).toMatchObject({
			old: { kind: 'other', what: 'text' },
			new: { kind: 'image', format: 'svg' }
		});
		const auth = { authorization: `Bearer ${daemon.token}` };
		const notImage = await rawRequest(daemon.port, {
			path: `/api/diffs/${id}/image?version=1&side=new&path=logo.bin`,
			headers: auth
		});
		expect(notImage.status).toBe(422);
		const before = await rawRequest(daemon.port, {
			path: `/api/diffs/${id}/image?version=1&side=old&path=logo.bin`,
			headers: auth
		});
		expect(before.status).toBe(200);
	});

	it('are read from the version asked for, while it is kept, and refused for one never had', async () => {
		const { repo, daemon, client, id } = await opened(images);
		await repo.write('assets/badge.png', STAMP);
		expect(value(await client.updateDiff(id)).kind).toBe('updated');
		const cookie = await browserCookie(daemon);
		const read = (at: number) =>
			fetch(
				`${daemon.origin}/api/diffs/${id}/image?version=${String(at)}&side=new&path=assets/badge.png`,
				{
					headers: { cookie }
				}
			);
		// The first version still shows the badge it had; the second, the new one.
		expect(new Uint8Array(await (await read(1)).arrayBuffer())).toEqual(BADGE_AFTER);
		expect(new Uint8Array(await (await read(2)).arrayBuffer())).toEqual(STAMP);
		const never = await read(3);
		expect(never.status).toBe(409);
		expect(await never.text()).toContain('This Delve has no version 3');
	});
});
