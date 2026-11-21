<!--
	A page that could not be shown: an address that leads nowhere, or an error
	nothing expected. It says which, and offers the way back.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status === 404 ? 'Not found' : 'Something went wrong'} – diff delver</title>
</svelte:head>

<h1>{page.status === 404 ? 'Nothing here' : 'Something went wrong'}</h1>
<p>{page.error?.message ?? 'This page could not be shown.'}</p>
<p><a href={resolve('/')}>See all your Delves</a></p>
