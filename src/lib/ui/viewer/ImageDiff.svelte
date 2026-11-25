<!--
	A changed image as pictures (DESIGN 8.4): each side it has, with its size in
	pixels and in bytes, read from diff delver's copy of the diff. An image
	changed in place is shown before and after, side by side; an added or a
	deleted one, its one side. Images of different sizes are lined up at the top
	left, and the page says so. Busy until every side is drawn or has failed.
-->
<script lang="ts">
	import type { ImageSideView, PartImageView } from '#lib/api/schemas.ts';
	import {
		describeDimensions,
		drawnScale,
		sameDimensions,
		type Dimensions
	} from '#lib/core/image/image-words.ts';
	import { MAX_IMAGE_SIZE, formatName } from '#lib/core/image/image-format.ts';
	import { pixelCountOf } from '#lib/core/pixel-count.tiny.ts';
	import type { Side } from '#lib/core/side.tiny.ts';
	import { describeByteSize } from '#lib/core/viewer/words.ts';

	let {
		image,
		address,
		name
	}: {
		image: PartImageView;
		/** Where a side's image is read from. */
		address: (side: Side) => string;
		/** The file's path as a person is shown it, for what is read out. */
		name: string;
	} = $props();

	type Drawn =
		| { readonly kind: 'loading' }
		| { readonly kind: 'drawn'; readonly size: Dimensions }
		| { readonly kind: 'failed' };

	let drawn = $state<Record<Side, Drawn>>({ old: { kind: 'loading' }, new: { kind: 'loading' } });

	const both = $derived(image.old !== null && image.new !== null);

	/** The sides there are, in order, each with what to call it. */
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

	/** Whether a side is still on its way. */
	function waiting(side: Side, shown: ImageSideView): boolean {
		return shown.kind === 'image' && drawn[side].kind === 'loading';
	}

	const busy = $derived(sides.some(({ side, shown }) => waiting(side, shown)));

	const sizes = $derived(
		sides.flatMap(({ side }) => {
			const d = drawn[side];
			return d.kind === 'drawn' ? [d.size] : [];
		})
	);
	const scale = $derived(drawnScale(sizes));

	/** When both sides are drawn and their sizes differ: the two sizes. */
	const differ = $derived.by(() => {
		const before = drawn.old;
		const after = drawn.new;
		if (before.kind !== 'drawn' || after.kind !== 'drawn') return undefined;
		return sameDimensions(before.size, after.size) ? undefined : { before, after };
	});

	function loaded(side: Side, element: HTMLImageElement): void {
		drawn[side] = {
			kind: 'drawn',
			size: {
				width: pixelCountOf(element.naturalWidth),
				height: pixelCountOf(element.naturalHeight)
			}
		};
	}
</script>

<div class="images" aria-busy={busy}>
	{#if differ !== undefined}
		<p class="note">
			The image changed size, from {describeDimensions(differ.before.size)} to {describeDimensions(
				differ.after.size
			)}, so the two are lined up at their top left corners.
		</p>
	{/if}
	<div class="side-by-side">
		{#each sides as { side, shown, label } (side)}
			{@const d = drawn[side]}
			<figure>
				<figcaption>
					<strong>{label}</strong>
					{#if shown.kind === 'image'}
						<span class="facts">
							{formatName(shown.format)}{#if d.kind === 'drawn'}, {describeDimensions(d.size)}{/if}, {describeByteSize(
								shown.size
							)}
						</span>
					{/if}
				</figcaption>
				{#if shown.kind === 'too-large'}
					<p class="about">
						Too large to show: {describeByteSize(shown.size)}. diff delver shows images of up to {describeByteSize(
							MAX_IMAGE_SIZE
						)}.
					</p>
				{:else if d.kind === 'failed'}
					<p class="about">
						This image could not be drawn: the browser could not read it as {shown.format === 'svg'
							? 'an'
							: 'a'}
						{formatName(shown.format)} image.
					</p>
				{:else}
					<div class="frame">
						<img
							src={address(side)}
							alt="{label}: {name}"
							class:enlarged={scale > 1}
							style:width={d.kind === 'drawn' ? `${String(d.size.width * scale)}px` : undefined}
							onload={(event) => {
								if (event.currentTarget instanceof HTMLImageElement) {
									loaded(side, event.currentTarget);
								}
							}}
							onerror={() => {
								drawn[side] = { kind: 'failed' };
							}}
						/>
					</div>
				{/if}
			</figure>
		{/each}
	</div>
</div>

<style>
	.images {
		padding: 0.75rem;
		border-bottom: 1px solid var(--color-border);
		font-size: 0.875rem;
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

	figcaption {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.5rem;
		margin-bottom: 0.35rem;
	}

	.facts,
	.about {
		color: var(--color-muted);
	}

	.about {
		margin: 0;
	}

	/* A checked ground, so what is see-through in an image shows as such. */
	.frame {
		display: inline-block;
		max-width: 100%;
		line-height: 0;
		border: 1px solid var(--color-border);
		background: repeating-conic-gradient(var(--color-subtle) 0 25%, var(--color-background) 0 50%) 0
			0 / 16px 16px;
	}

	img {
		max-width: 100%;
		height: auto;
	}

	img.enlarged {
		image-rendering: pixelated;
	}
</style>
