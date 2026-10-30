import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import create_manifest_data, { get_access_files } from './index.js';
import { app_prefix, create_mounts } from './mounts.js';
import { validate_config } from '../../config/index.js';

/** @type {string[]} */
const roots = [];

afterEach(() => {
	for (const root of roots) {
		fs.rmSync(root, { recursive: true, force: true });
	}

	roots.length = 0;
});

/**
 * Creates a project with a `src/apps` directory. Keys are paths relative to the project root.
 * @param {Record<string, string>} files
 */
function create_app(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-kit-apps-'));
	roots.push(root);

	for (const [name, contents] of Object.entries(files)) {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, contents);
	}

	const config = validate_config({});
	config.files.assets = path.join(root, 'static');
	config.files.params = path.join(root, 'src/params');
	config.files.routes = path.join(root, 'src/routes');
	config.files.apps = path.join(root, 'src/apps');

	return { root, config, manifest_data: create_manifest_data(config, root) };
}

test('normalises app directory names into prefixes', () => {
	expect(app_prefix('@root')).toBe('');
	expect(app_prefix('shop')).toBe('/shop');
	expect(app_prefix('ChequeParser')).toBe('/chequeparser');
	expect(app_prefix('Cheque_Parser')).toBe('/cheque-parser');
});

test('creates a `views` mount and an `api` mount for every app', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-kit-apps-'));
	roots.push(root);

	for (const dir of ['@root/views', '@root/api', 'shop/views', 'shop/api']) {
		fs.mkdirSync(path.join(root, 'src/apps', dir), { recursive: true });
	}

	const mounts = create_mounts(path.join(root, 'src/apps'), root);

	expect(mounts.map((mount) => [mount.app, mount.tree, mount.prefix, mount.id_prefix])).toEqual([
		['@root', 'views', '', ''],
		['@root', 'api', '', '/__api'],
		['shop', 'views', '/shop', '/shop'],
		['shop', 'api', '/shop', '/__api/shop']
	]);
});

test('routes every app on both trees, with isolated layouts', () => {
	const { manifest_data } = create_app({
		'src/apps/@root/@layout.svelte': '<slot />',
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/@root/api/health/+server.js': 'export function GET() {}',
		'src/apps/ChequeParser/views/+layout.svelte': '<slot />',
		'src/apps/ChequeParser/views/+page.svelte': '',
		'src/apps/ChequeParser/api/+server.js': 'export function POST() {}',
		'src/apps/shop/views/+page.svelte': ''
	});

	// `view` routes keep their pathname, `api` routes are namespaced so the `RouteId` union stays
	// unambiguous when a pathname exists on both origins
	expect(manifest_data.routes.map((route) => route.id)).toEqual([
		'/',
		'/__api/chequeparser',
		'/__api/health',
		'/chequeparser',
		'/shop'
	]);

	// the global layout is the first node, because `respond_with_error` relies on `nodes[0]` being
	// the root layout and `nodes[1]` the fallback error
	const [root_layout, error] = manifest_data.nodes;
	expect(root_layout.component).toBe('src/apps/@root/@layout.svelte');
	expect(root_layout.global).toBe(true);
	expect(error.component?.endsWith('error.svelte')).toBe(true);
	expect(manifest_data.root_layout_dir).toBe('src/apps/@root');

	for (const route of manifest_data.routes) {
		if (!route.page) continue;

		// every page is wrapped by `@layout`, regardless of app or tree
		expect(route.page.layouts[0]).toBe(0);
		expect(route.page.errors[0]).toBe(1);
	}

	const own_layouts = (/** @type {string} */ component) => {
		const route = manifest_data.routes.find(
			(route) => route.page && manifest_data.nodes[route.page.leaf].component === component
		);

		if (!route?.page) throw new Error(`no page route for ${component}`);

		return route.page.layouts.map(
			(index) =>
				/** @type {import('types').PageNode} */ (manifest_data.nodes[Number(index)]).component
		);
	};

	// an app's layout applies to its own pages...
	expect(own_layouts('src/apps/ChequeParser/views/+page.svelte')).toEqual([
		'src/apps/@root/@layout.svelte',
		'src/apps/ChequeParser/views/+layout.svelte'
	]);

	// ...and to nothing else
	expect(own_layouts('src/apps/shop/views/+page.svelte')).toEqual([
		'src/apps/@root/@layout.svelte'
	]);
	expect(own_layouts('src/apps/@root/views/+page.svelte')).toEqual([
		'src/apps/@root/@layout.svelte'
	]);
});

test('supports group and parameter directories within a mount', () => {
	const { manifest_data } = create_app({
		'src/apps/@root/@layout.svelte': '<slot />',
		'src/apps/@root/views/(marketing)/+layout.svelte': '<slot />',
		'src/apps/@root/views/(marketing)/about/+page.svelte': '',
		'src/apps/shop/views/(grouped)/[id]/+page.svelte': '',
		'src/apps/shop/views/files/[...path]/+page.svelte': '',
		'src/apps/shop/api/(grouped)/[id]/+server.js': 'export function GET() {}'
	});

	/** @param {string} id */
	const route = (id) => {
		const found = manifest_data.routes.find((route) => route.id === id);
		if (!found) throw new Error(`no route ${id}`);
		return found;
	};

	// group segments are part of the id, but not of the pathname
	expect(route('/(marketing)/about').pattern.test('/about')).toBe(true);
	expect(route('/(marketing)/about').pattern.test('/(marketing)/about')).toBe(false);

	expect(route('/shop/(grouped)/[id]').pattern.test('/shop/abc')).toBe(true);
	expect(route('/shop/(grouped)/[id]').params.map((param) => param.name)).toEqual(['id']);

	expect(route('/shop/files/[...path]').pattern.test('/shop/files/a/b')).toBe(true);

	// the `api` tree is namespaced, so the same pathname can exist on both trees
	expect(route('/__api/shop/(grouped)/[id]').pattern.test('/shop/abc')).toBe(true);

	// a group's layout applies to pages below it, after the global layout
	const about = route('/(marketing)/about');
	if (!about.page) throw new Error('expected a page route');

	const layouts = /** @type {number[]} */ (about.page.layouts).map(
		(index) => /** @type {import('types').PageNode} */ (manifest_data.nodes[index]).component
	);

	expect(layouts).toEqual([
		'src/apps/@root/@layout.svelte',
		'src/apps/@root/views/(marketing)/+layout.svelte'
	]);

	// the group itself has only a layout, so it is kept for node generation but is not routable
	const group = route('/(marketing)');
	expect(group.page).toBe(null);
	expect(group.endpoint).toBe(null);
	expect(group.pattern.test('/about')).toBe(false);
});

test('api routes are endpoints only', () => {
	const { manifest_data } = create_app({
		'src/apps/@root/@layout.svelte': '<slot />',
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/@root/api/health/+server.js': 'export function GET() {}'
	});

	const route = manifest_data.routes.find((route) => route.id === '/__api/health');

	expect(route?.tree).toBe('api');
	expect(route?.page).toBe(null);
	expect(route?.endpoint?.file).toBe('src/apps/@root/api/health/+server.js');
});

test('legacy mode keeps a single mount and no global layout', () => {
	const { manifest_data } = create_app({
		'src/routes/+page.svelte': ''
	});

	expect(manifest_data.mounts.map((mount) => [mount.app, mount.prefix, mount.base])).toEqual([
		['@root', '', 'src/routes']
	]);
	expect(manifest_data.root_layout).toBe(null);
});

test('errors when an app other than @root defines a global layout', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/shop/@layout.svelte': '<slot />',
			'src/apps/shop/views/+page.svelte': ''
		})
	).toThrowKitError('app_global_layout_not_root');
});

test('errors when two apps resolve to the same prefix', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/Cheque-Parser/views/+page.svelte': '',
			'src/apps/Cheque_Parser/views/+page.svelte': ''
		})
	).toThrowKitError('app_prefix_duplicate');
});

test('errors when an app is named `root`, which would collide with `apps.root`', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/root/views/+page.svelte': ''
		})
	).toThrowKitError('app_root_name_reserved');
});

test('errors when the api tree contains a component', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/@root/api/+page.svelte': ''
		})
	).toThrowKitError('app_api_file_not_allowed');
});

test('errors when the api tree contains a layout', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/@root/api/+layout.svelte': '<slot />'
		})
	).toThrowKitError('app_api_file_not_allowed');
});

test('errors when no app contains any routes', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/README.md': ''
		})
	).toThrowKitError('apps_no_routes');
});

test('errors when an app has no route directory', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/shop/README.md': ''
		})
	).toThrowKitError('app_no_route_directory');
});

test('errors when an api endpoint is prerendered', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/@root/api/+server.js': 'export const prerender = true; export function GET() {}'
		})
	).toThrowKitError('app_api_prerender');
});

test('discovers each app’s `@permissions` module and each route’s `+access` module', () => {
	const { manifest_data } = create_app({
		'src/apps/@root/@permissions.ts': 'export const permissions = [] as const;',
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/@root/views/+access.ts': 'export const requires = [];',
		'src/apps/@root/views/admin/+access.ts': 'export const requires = [];',
		'src/apps/@root/views/admin/+page.svelte': '',
		'src/apps/shop/views/+page.svelte': ''
	});

	expect(manifest_data.permissions).toEqual([
		{ app: '@root', file: 'src/apps/@root/@permissions.ts' }
	]);

	const admin = manifest_data.routes.find((route) => route.id === '/admin');

	expect(admin?.access).toBe('src/apps/@root/views/admin/+access.ts');
	expect(get_access_files(/** @type {import('types').RouteData} */ (admin))).toEqual([
		'src/apps/@root/views/+access.ts',
		'src/apps/@root/views/admin/+access.ts'
	]);

	const shop = manifest_data.routes.find((route) => route.id === '/shop');

	expect(shop?.access).toBe(null);
	expect(shop?.app).toBe('shop');
});

test('allows a `+access.d.ts` alongside a `+access.ts`', () => {
	const { manifest_data } = create_app({
		'src/apps/@root/@permissions.ts': 'export const permissions = [] as const;',
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/@root/views/+access.ts': 'export const requires = [];',
		'src/apps/@root/views/+access.d.ts': ''
	});

	expect(manifest_data.routes.find((route) => route.id === '/')?.access).toBe(
		'src/apps/@root/views/+access.ts'
	);
});

test('errors when two `+access` modules exist in one directory', () => {
	expect(() =>
		create_app({
			'src/apps/@root/@permissions.ts': 'export const permissions = [] as const;',
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/@root/views/+access.js': '',
			'src/apps/@root/views/+access.ts': ''
		})
	).toThrowKitError('route_duplicate_files');
});

test('errors when a `+access` module has no `@permissions` module to expand against', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/@root/views/+access.ts': 'export const requires = [];'
		})
	).toThrowKitError('app_access_without_permissions');
});

test('errors when a route with requirements is prerendered', () => {
	expect(() =>
		create_app({
			'src/apps/@root/@permissions.ts': 'export const permissions = [] as const;',
			'src/apps/@root/views/+access.ts': 'export const requires = [];',
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/@root/views/+page.ts': 'export const prerender = true;'
		})
	).toThrowKitError('app_permissions_prerender');
});

test('errors when an endpoint inherits requirements and is prerendered', () => {
	expect(() =>
		create_app({
			'src/apps/@root/@permissions.ts': 'export const permissions = [] as const;',
			'src/apps/@root/views/+access.ts': 'export const requires = [];',
			'src/apps/@root/views/+page.svelte': '',
			'src/apps/@root/views/ping/+access.ts': 'export const requires = [];',
			'src/apps/@root/views/ping/+server.js':
				'export const prerender = true; export function GET() {}'
		})
	).toThrowKitError('app_permissions_prerender');
});

test('leaves `+access` reserved in legacy mode', () => {
	expect(() =>
		create_app({
			'src/routes/+page.svelte': '',
			'src/routes/+access.ts': 'export const requires = [];'
		})
	).toThrowKitError('route_file_reserved');
});

test('errors when a route has both a page and an endpoint', () => {
	expect(() =>
		create_app({
			'src/apps/@root/views/ping/+page.svelte': '',
			'src/apps/@root/views/ping/+server.js': 'export function GET() {}'
		})
	).toThrowKitError('app_page_and_endpoint');
});

test('allows the same pathname as a page on the views tree and an endpoint on the api tree', () => {
	const { manifest_data } = create_app({
		'src/apps/@root/views/ping/+page.svelte': '',
		'src/apps/@root/api/ping/+server.js': 'export function GET() {}'
	});

	expect(manifest_data.routes.map((route) => route.id)).toEqual(['/__api/ping', '/ping']);
});
