/** @import { SSRManifest, SSRRoute } from 'types' */

/**
 * Cached `views`/`api` partitions of `manifest.routes`, keyed by manifest identity so that the
 * partition is computed once per manifest rather than once per request.
 * @type {WeakMap<object, { views: SSRRoute[], api: SSRRoute[] }>}
 */
const route_trees = new WeakMap();

/**
 * Returns the routes for the origin the request came in on. A project with `src/apps` is a single
 * deployment serving both `domain.com` and `api.domain.com`, so the hostname decides which tree
 * we route against.
 * @param {string} hostname
 * @param {SSRManifest} manifest
 * @returns {SSRRoute[]}
 */
export function routes_for(hostname, manifest) {
	let trees = route_trees.get(manifest);

	if (!trees) {
		/** @type {SSRRoute[]} */
		const views = [];
		/** @type {SSRRoute[]} */
		const api = [];

		for (const route of manifest.routes) {
			(route.tree === 'api' ? api : views).push(route);
		}

		trees = { views, api };
		route_trees.set(manifest, trees);
	}

	return is_api_host(hostname, manifest.api_host ?? null) ? trees.api : trees.views;
}

/**
 * `api.example.com` (and `api.localhost` in development) is the API origin unless
 * [`router.api_host`](https://svelte.dev/docs/kit/@sveltejs-kit-vite#router) says otherwise.
 * @param {string} hostname
 * @param {string | null} api_host
 */
export function is_api_host(hostname, api_host) {
	if (api_host) return hostname === api_host;

	return hostname === 'api.localhost' || hostname.startsWith('api.');
}
