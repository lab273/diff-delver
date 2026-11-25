<!--
	A changed image as pictures (DESIGN 8.4): each side it has, with its size in
	pixels and in bytes, read from diff delver's copy of the diff. An added or a
	deleted image shows its one side. An image changed in place is compared in
	the way the reviewer chose, the same for every image on the page: side by
	side; with a slider over the two, dragged or moved with the arrow keys to
	show more of either; onion skin, the image after over the one before, as
	see-through as the reviewer likes; or pixel difference, the pixels that
	changed in magenta over a faded copy of the image after, worked out in the
	page by the rule in `core/image/pixel-difference.ts`, with how many changed.
	Images of different
	sizes are lined up at the top left, and the page says so. Busy until what
	the chosen way shows is drawn, or has failed.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { ImageSideView, PartImageView } from '#lib/api/schemas.ts';
	import {
		COMPARE_MODES,
		compareModeName,
		type CompareMode
	} from '#lib/core/image/compare-modes.ts';
	import {
		describeDimensions,
		describeNotImage,
		drawnScale,
		sameDimensions,
		spanOf,
		type Dimensions
	} from '#lib/core/image/image-words.ts';
	import { MAX_IMAGE_SIZE, formatName } from '#lib/core/image/image-format.ts';
	import {
		comparable,
		MAX_COMPARED_PIXELS,
		pixelDifference,
		type PixelDifference,
		type Pixels
	} from '#lib/core/image/pixel-difference.ts';
	import { pixelCountOf } from '#lib/core/pixel-count.tiny.ts';
	import type { Side } from '#lib/core/side.tiny.ts';
	import { describeByteSize, formatCount } from '#lib/core/viewer/words.ts';

	let {
		image,
		address,
		name,
		mode,
		onmode
	}: {
		image: PartImageView;
		/** Where a side's image is read from. */
		address: (side: Side) => string;
		/** The file's path as a person is shown it, for what is read out. */
		name: string;
		/** How a changed image is compared: the reviewer's choice, for every image on the page. */
		mode: CompareMode;
		onmode: (mode: CompareMode) => void;
	} = $props();

	/** Each side's size in pixels, once a picture of it has loaded. */
	let sizes = $state<Record<Side, Dimensions | undefined>>({ old: undefined, new: undefined });
	/** Each side the browser could not read. */
	let failed = $state<Record<Side, boolean>>({ old: false, new: false });
	/** Which pictures have loaded, as `<drawing>:<side>`. */
	const loaded = new SvelteSet<string>();

	/** Where the slider is: how much of the width, from the left, shows the image before. */
	let slider = $state(50);
	/** How much the image after shows over the one before, in onion skin, from 0 to 100. */
	let opacity = $state(50);

	/** Whether the file has both sides, whatever each is: a changed file, not an added or deleted one. */
	const both = $derived(image.old !== null && image.new !== null);

	/** The sides the file has, in order, each with what to call it. */
	const sides = $derived(
		(['old', 'new'] as const).flatMap((side) => {
			const shown = image[side];
			if (shown === null) return [];
			const label = both
				? side === 'old'
					? 'Before'
					: 'After'
				: side === 'old'
					? 'Deleted'
					: 'Added';
			return [{ side, shown, label }];
		})
	);

	/** Whether the two sides can be compared other than side by side: both are pictures the browser reads. */
	const comparing = $derived(
		image.old?.kind === 'image' && image.new?.kind === 'image' && !failed.old && !failed.new
	);
	const shownMode = $derived<CompareMode>(comparing ? mode : 'side-by-side');

	/** The pictures and controls, and each way's button. */
	let container = $state<HTMLDivElement>();
	const buttons = $state<Partial<Record<CompareMode, HTMLButtonElement>>>({});

	// A slider with the focus goes when the way changes, by its button or by
	// `i`: the focus goes to the button of the way now chosen, not to the page.
	$effect.pre(() => {
		const now = shownMode;
		const active = document.activeElement;
		const held =
			active instanceof HTMLInputElement &&
			active.type === 'range' &&
			untrack(() => container)?.contains(active) === true;
		if (!held) return;
		void tick().then(() => {
			if (container?.contains(document.activeElement) === true) return;
			buttons[now]?.focus();
		});
	});

	const scale = $derived(
		drawnScale(
			sides.flatMap(({ side }) => {
				const size = sizes[side];
				return size === undefined ? [] : [size];
			})
		)
	);
	const span = $derived(
		sizes.old !== undefined && sizes.new !== undefined ? spanOf(sizes.old, sizes.new) : undefined
	);
	const differ = $derived(
		sizes.old !== undefined && sizes.new !== undefined && !sameDimensions(sizes.old, sizes.new)
			? { before: sizes.old, after: sizes.new }
			: undefined
	);

	/**
	 * Which pictures a mode draws: side by side its own, the slider and onion
	 * skin the same two, one over the other.
	 */
	type Drawing = 'apart' | 'stacked';

	/** Whether this side's picture, as a mode draws it, has yet to load. */
	function waiting(drawnIn: Drawing, side: Side, shown: ImageSideView): boolean {
		return shown.kind === 'image' && !failed[side] && !loaded.has(`${drawnIn}:${side}`);
	}

	/** What comparing the pixels found, while the reviewer compares them. */
	type Difference =
		| { readonly kind: 'working' }
		| { readonly kind: 'found'; readonly found: PixelDifference; readonly painted: boolean }
		| { readonly kind: 'too-large'; readonly span: Dimensions }
		| { readonly kind: 'failed'; readonly why: CompareFailure };
	/**
	 * Why the pixels could not be compared: the browser could not read an image,
	 * one has no size in pixels, or the browser could not draw them or read
	 * their pixels back, as when it has not the memory.
	 */
	type CompareFailure = 'unreadable' | 'no-size' | 'not-drawn';
	let difference = $state<Difference>({ kind: 'working' });

	const busy = $derived.by(() => {
		switch (shownMode) {
			case 'side-by-side':
			case 'slider':
			case 'onion-skin':
				return sides.some(({ side, shown }) =>
					waiting(shownMode === 'side-by-side' ? 'apart' : 'stacked', side, shown)
				);
			case 'pixel-difference':
				return (
					difference.kind === 'working' || (difference.kind === 'found' && !difference.painted)
				);
		}
	});

	/**
	 * A side's picture once it has loaded, with its size known but not yet
	 * decoded to pixels; undefined when the browser cannot read it.
	 */
	function loadedPicture(where: string): Promise<HTMLImageElement | undefined> {
		const picture = new Image();
		const done = new Promise<HTMLImageElement | undefined>((resolve) => {
			picture.onload = () => {
				resolve(picture);
			};
			picture.onerror = () => {
				resolve(undefined);
			};
		});
		picture.src = where;
		return done;
	}

	/** Whether a picture has a size in pixels to compare: an SVG without one may not. */
	function hasSize(picture: HTMLImageElement): boolean {
		return picture.naturalWidth > 0 && picture.naturalHeight > 0;
	}

	function sizeOf(picture: HTMLImageElement): Dimensions {
		return {
			width: pixelCountOf(picture.naturalWidth),
			height: pixelCountOf(picture.naturalHeight)
		};
	}

	/** A picture's pixels, as a canvas draws them; this may throw, as when the browser has not the memory. */
	function pixelsOf(picture: HTMLImageElement): Pixels | undefined {
		const canvas = document.createElement('canvas');
		canvas.width = picture.naturalWidth;
		canvas.height = picture.naturalHeight;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (context === null) return undefined;
		context.drawImage(picture, 0, 0);
		return {
			...sizeOf(picture),
			data: context.getImageData(0, 0, canvas.width, canvas.height).data
		};
	}

	// The pixels are compared each time the reviewer asks for it, from the two
	// pictures loaded again, which the browser has already: their sizes are
	// checked before either is drawn, and anything that goes wrong drawing or
	// comparing them is said, never left working.
	$effect(() => {
		if (shownMode !== 'pixel-difference') return;
		const run = { stopped: false };
		const [before, after] = untrack(() => {
			difference = { kind: 'working' };
			return [address('old'), address('new')];
		});
		void (async () => {
			const pictures = await Promise.all([loadedPicture(before), loadedPicture(after)]);
			if (run.stopped) return;
			difference = compared(pictures[0], pictures[1]);
		})().catch(() => {
			if (!run.stopped) difference = { kind: 'failed', why: 'not-drawn' };
		});
		return () => {
			run.stopped = true;
		};
	});

	/** What comparing two loaded pictures finds, or why they could not be compared. */
	function compared(a: HTMLImageElement | undefined, b: HTMLImageElement | undefined): Difference {
		if (a === undefined || b === undefined) return { kind: 'failed', why: 'unreadable' };
		if (!hasSize(a) || !hasSize(b)) return { kind: 'failed', why: 'no-size' };
		sizes.old ??= sizeOf(a);
		sizes.new ??= sizeOf(b);
		if (!comparable(sizeOf(a), sizeOf(b))) {
			return { kind: 'too-large', span: spanOf(sizeOf(a), sizeOf(b)) };
		}
		try {
			const pixelsBefore = pixelsOf(a);
			const pixelsAfter = pixelsOf(b);
			if (pixelsBefore === undefined || pixelsAfter === undefined) {
				return { kind: 'failed', why: 'not-drawn' };
			}
			return { kind: 'found', found: pixelDifference(pixelsBefore, pixelsAfter), painted: false };
		} catch {
			return { kind: 'failed', why: 'not-drawn' };
		}
	}

	/** What the page says when the pixels could not be compared. */
	function failureText(why: CompareFailure): string {
		switch (why) {
			case 'unreadable':
				return 'The pixels could not be compared: the browser could not read one of the images. Compare them side by side instead.';
			case 'no-size':
				return 'The pixels could not be compared: one of the images has no size in pixels, as an SVG without a width and a height may not. Compare them side by side instead.';
			case 'not-drawn':
				return 'The pixels could not be compared: the browser could not draw the images to read their pixels. Compare them side by side instead.';
		}
	}

	/** Draws what comparing the pixels found on its canvas, or says why it could not. */
	function paint(canvas: HTMLCanvasElement, found: PixelDifference) {
		const draw = (shown: PixelDifference): void => {
			if (difference.kind !== 'found' || difference.found !== shown) return;
			try {
				canvas.width = shown.width;
				canvas.height = shown.height;
				const context = canvas.getContext('2d');
				if (context === null) throw new Error('No 2D context');
				const data = new Uint8ClampedArray(shown.data);
				context.putImageData(new ImageData(data, shown.width, shown.height), 0, 0);
				difference = { ...difference, painted: true };
			} catch {
				difference = { kind: 'failed', why: 'not-drawn' };
			}
		};
		draw(found);
		return { update: draw };
	}

	function onload(drawnIn: Drawing, side: Side, event: Event): void {
		const element = event.currentTarget;
		if (!(element instanceof HTMLImageElement)) return;
		sizes[side] ??= {
			width: pixelCountOf(element.naturalWidth),
			height: pixelCountOf(element.naturalHeight)
		};
		loaded.add(`${drawnIn}:${side}`);
	}

	/** Moves the slider to where the pointer is over the pictures. */
	function slideTo(event: PointerEvent): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLElement)) return;
		const box = target.getBoundingClientRect();
		if (box.width === 0) return;
		const at = ((event.clientX - box.left) / box.width) * 100;
		slider = Math.round(Math.min(100, Math.max(0, at)));
	}

	/** How wide a picture of this many pixels across is drawn; unset when it has no width. */
	function drawnWidth(width: number | undefined): string | undefined {
		return width === undefined || width === 0 ? undefined : `${String(width * scale)}px`;
	}

	/** A side's width as a share of the area both are drawn in. */
	function share(side: Side): string | undefined {
		const size = sizes[side];
		return size === undefined || span === undefined || span.width === 0
			? undefined
			: `${String((size.width / span.width) * 100)}%`;
	}

	/** What a side is: "PNG, 48 × 32 pixels, 140 bytes", or "Not an image: binary file, 140 bytes". */
	function facts(side: Side, shown: ImageSideView): string {
		if (shown.kind === 'other') return describeNotImage(shown.what, shown.size);
		const size = sizes[side];
		return [
			formatName(shown.format),
			...(size === undefined ? [] : [describeDimensions(size)]),
			describeByteSize(shown.size)
		].join(', ');
	}
</script>

<div class="images" aria-busy={busy} bind:this={container}>
	{#if comparing}
		<div class="modes">
			<div class="switch" role="group" aria-label="Compare the images of {name}">
				{#each COMPARE_MODES as each (each)}
					<button
						type="button"
						bind:this={buttons[each]}
						aria-pressed={mode === each}
						onclick={() => {
							onmode(each);
						}}
					>
						{compareModeName(each)}
					</button>
				{/each}
			</div>
			<span class="hint" aria-hidden="true"><kbd>i</kbd> switches</span>
		</div>
	{/if}
	{#if differ !== undefined}
		<p class="note">
			The image changed size, from {describeDimensions(differ.before)} to {describeDimensions(
				differ.after
			)}, so the two are lined up at their top left corners.
		</p>
	{/if}
	{#if shownMode === 'side-by-side'}
		<div class="side-by-side">
			{#each sides as { side, shown, label } (side)}
				<figure>
					<figcaption>
						<strong>{label}</strong>
						<span class="facts">{facts(side, shown)}</span>
					</figcaption>
					{#if shown.kind === 'other'}
						<!-- No picture: its caption says what it is. -->
					{:else if shown.kind === 'too-large'}
						<p class="about">
							Too large to show: {describeByteSize(shown.size)}. diff delver shows images of up to {describeByteSize(
								MAX_IMAGE_SIZE
							)}.
						</p>
					{:else if failed[side]}
						<p class="about">
							This image could not be drawn: the browser could not read it as {shown.format ===
							'svg'
								? 'an'
								: 'a'}
							{formatName(shown.format)} image.
						</p>
					{:else}
						{@const size = sizes[side]}
						<div class="frame">
							<img
								src={address(side)}
								alt="{label}: {name}"
								class:enlarged={scale > 1}
								style:width={drawnWidth(size?.width)}
								onload={(event) => {
									onload('apart', side, event);
								}}
								onerror={() => {
									failed[side] = true;
								}}
							/>
						</div>
					{/if}
				</figure>
			{/each}
		</div>
	{:else if shownMode === 'slider' || shownMode === 'onion-skin'}
		{@const overlay = shownMode}
		<p class="captions">
			{#each sides as { side, shown, label } (side)}
				<span><strong>{label}</strong> <span class="facts">{facts(side, shown)}</span></span>
			{/each}
		</p>
		<div class="frame">
			<div
				role="presentation"
				class="stack"
				class:sliding={overlay === 'slider'}
				style:width={drawnWidth(span?.width)}
				style:aspect-ratio={span === undefined || span.width === 0 || span.height === 0
					? undefined
					: `${String(span.width)} / ${String(span.height)}`}
				onpointerdown={(event) => {
					if (overlay !== 'slider') return;
					event.currentTarget.setPointerCapture(event.pointerId);
					slideTo(event);
				}}
				onpointermove={(event) => {
					if (overlay === 'slider' && event.buttons === 1) slideTo(event);
				}}
			>
				<div class="layer">
					<img
						src={address('old')}
						alt="Before: {name}"
						class:enlarged={scale > 1}
						style:width={share('old')}
						draggable="false"
						onload={(event) => {
							onload('stacked', 'old', event);
						}}
						onerror={() => {
							failed.old = true;
						}}
					/>
				</div>
				<div
					class="layer after"
					style:clip-path={overlay === 'slider' ? `inset(0 0 0 ${String(slider)}%)` : undefined}
					style:opacity={overlay === 'onion-skin' ? String(opacity / 100) : undefined}
				>
					<img
						src={address('new')}
						alt="After: {name}"
						class:enlarged={scale > 1}
						style:width={share('new')}
						draggable="false"
						onload={(event) => {
							onload('stacked', 'new', event);
						}}
						onerror={() => {
							failed.new = true;
						}}
					/>
				</div>
				{#if overlay === 'slider'}
					<div class="divider" style:left="{slider}%"></div>
				{/if}
			</div>
		</div>
		<div class="control">
			<span aria-hidden="true">Before</span>
			{#if overlay === 'slider'}
				<input
					type="range"
					min="0"
					max="100"
					step="1"
					bind:value={slider}
					aria-label="Slider between the image before, on the left, and after, on the right: {name}"
					aria-valuetext="{slider}% before, {100 - slider}% after"
				/>
			{:else}
				<input
					type="range"
					min="0"
					max="100"
					step="1"
					bind:value={opacity}
					aria-label="How much the image after shows over the one before: {name}"
					aria-valuetext="After shown at {opacity}%"
				/>
			{/if}
			<span aria-hidden="true">After</span>
		</div>
	{:else}
		<p class="captions">
			{#each sides as { side, shown, label } (side)}
				<span><strong>{label}</strong> <span class="facts">{facts(side, shown)}</span></span>
			{/each}
		</p>
		{#if difference.kind === 'found'}
			{@const found = difference.found}
			<p class="count">
				{#if found.changed === 0}
					No pixels changed: the two images look the same, though their files differ.
				{:else}
					<strong>
						{formatCount(found.changed)} of {formatCount(found.compared)} pixels changed
					</strong>, shown in magenta over a faded copy of the image after.
				{/if}
			</p>
			<div class="frame" role="img" aria-label="The pixels that changed in {name}, in magenta">
				<canvas use:paint={found} class:enlarged={scale > 1} style:width={drawnWidth(found.width)}
				></canvas>
			</div>
		{:else if difference.kind === 'too-large'}
			<p class="about">
				These images are too large to compare pixel by pixel: {describeDimensions(difference.span)}
				together, and diff delver compares up to {formatCount(MAX_COMPARED_PIXELS)} pixels. Compare them
				side by side, with the slider or in onion skin instead.
			</p>
		{:else if difference.kind === 'failed'}
			<p class="about">{failureText(difference.why)}</p>
		{:else}
			<p class="about">Comparing the pixels…</p>
		{/if}
	{/if}
</div>

<style>
	.images {
		padding: 0.75rem;
		border-bottom: 1px solid var(--color-border);
		font-size: 0.875rem;
	}

	.modes {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		margin-bottom: 0.75rem;
	}

	.switch {
		display: flex;
		flex-wrap: wrap;
	}

	.switch button {
		font-size: 0.8125rem;
		padding: 0.15rem 0.6rem;
		border-radius: 0;
	}

	.switch button + button {
		border-left: 0;
	}

	.switch button:first-child {
		border-radius: 6px 0 0 6px;
	}

	.switch button:last-child {
		border-radius: 0 6px 6px 0;
	}

	.switch button[aria-pressed='true'] {
		background: var(--color-selected-button);
		border-color: var(--color-accent);
		color: var(--color-text);
	}

	.hint {
		color: var(--color-muted);
		font-size: 0.75rem;
	}

	kbd {
		font-size: 0.75rem;
		border: 1px solid currentColor;
		border-radius: 4px;
		padding: 0 0.3rem;
	}

	.note {
		margin: 0 0 0.75rem;
		padding: 0.4rem 0.75rem;
		background: var(--color-info-background);
		border: 1px solid var(--color-info-border);
		border-radius: 6px;
	}

	.side-by-side {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: flex-start;
	}

	figure {
		margin: 0;
		min-width: 0;
		max-width: 100%;
	}

	figcaption,
	.captions {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.5rem;
		margin: 0 0 0.35rem;
	}

	.captions {
		gap: 0 1.5rem;
	}

	.facts,
	.about {
		color: var(--color-muted);
	}

	.about {
		margin: 0;
	}

	/* A checked ground, so what is see-through in an image shows as such. */
	.frame,
	.sliding .after {
		background: repeating-conic-gradient(var(--color-subtle) 0 25%, var(--color-background) 0 50%) 0
			0 / 16px 16px;
	}

	.frame {
		display: inline-block;
		max-width: 100%;
		line-height: 0;
		border: 1px solid var(--color-border);
	}

	img,
	canvas {
		max-width: 100%;
		height: auto;
	}

	canvas {
		display: block;
	}

	.count {
		margin: 0 0 0.5rem;
	}

	.enlarged {
		image-rendering: pixelated;
	}

	.stack {
		position: relative;
		max-width: 100%;
		touch-action: none;
	}

	.sliding {
		cursor: ew-resize;
	}

	.layer {
		position: absolute;
		inset: 0;
	}

	.layer img {
		position: absolute;
		top: 0;
		left: 0;
		max-width: none;
		user-select: none;
	}

	.divider {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		margin-left: -1px;
		background: var(--color-accent);
		pointer-events: none;
	}

	.control {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 24rem;
		margin-top: 0.5rem;
		color: var(--color-muted);
	}

	.control input {
		flex: 1;
		accent-color: var(--color-accent);
	}
</style>
