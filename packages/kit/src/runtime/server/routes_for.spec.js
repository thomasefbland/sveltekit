import { expect, test } from 'vitest';
import { is_api_host, routes_for } from './routes_for.js';

/**
 * @param {string} hostname
 * @param {string | null} [api_host]
 */
function routes_for_host(hostname, api_host = null) {
	const manifest = /** @type {import('types').SSRManifest} */ ({
		routes: [
			{ id: '/', tree: 'views' },
			{ id: '/shop', tree: 'views' },
			{ id: '/__api/health', tree: 'api' }
		],
		api_host
	});

	return routes_for(hostname, manifest).map((route) => route.id);
}

test('serves the `views` tree from the main origin', () => {
	expect(routes_for_host('example.com')).toEqual(['/', '/shop']);
	expect(routes_for_host('www.example.com')).toEqual(['/', '/shop']);
});

test('serves the `api` tree from any `api.` host', () => {
	expect(routes_for_host('api.example.com')).toEqual(['/__api/health']);
	expect(routes_for_host('api.localhost')).toEqual(['/__api/health']);
});

test('`router.api_host` overrides the `api.` convention', () => {
	expect(routes_for_host('backend.example.com', 'backend.example.com')).toEqual(['/__api/health']);
	expect(routes_for_host('api.example.com', 'backend.example.com')).toEqual(['/', '/shop']);
});

test('host matching is exact', () => {
	expect(is_api_host('api.example.com', 'api.example.com')).toBe(true);
	expect(is_api_host('api.example.com.evil.com', 'api.example.com')).toBe(false);
});
