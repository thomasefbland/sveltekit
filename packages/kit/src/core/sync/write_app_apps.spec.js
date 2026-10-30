import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import create_manifest_data from './create_manifest_data/index.js';
import { write_app_apps, write_app_apps_types } from './write_app_apps.js';
import { validate_config } from '../config/index.js';

/** @type {string[]} */
const roots = [];

afterEach(() => {
	for (const root of roots) {
		fs.rmSync(root, { recursive: true, force: true });
	}

	roots.length = 0;
});

/**
 * Creates a project with a `src/apps` directory, generates the `$app/apps` module for it and
 * imports it. The generated module is plain JavaScript, so it can be evaluated directly — which
 * is what the real build does, except through Vite.
 * @param {Record<string, string>} files
 */
async function load(files) {
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

	const manifest_data = create_manifest_data(config, root);
	const out = path.join(root, '.svelte-kit/generated/dev');

	write_app_apps(out, manifest_data, root);
	write_app_apps_types(manifest_data, root);

	const module = await import(pathToFileURL(path.join(out, 'app-apps.js')).href);

	return { root, manifest_data, module };
}

/**
 * @param {Record<string, string>} files
 */
async function load_error(files) {
	try {
		await load(files);
	} catch (error) {
		return /** @type {Error} */ (error).message;
	}

	throw new Error('expected the generated module to throw');
}

const PERMISSIONS = `export const permissions = [
	'documents.read',
	'documents.write',
	'cloud.storage.buckets.create',
	'cloud.storage.buckets.delete',
	'cloud.storage.objects.list'
];
`;

test('nests each app’s permissions, namespaced by app', async () => {
	const { module } = await load({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/Cheque_Parser/@permissions.js': PERMISSIONS,
		'src/apps/Cheque_Parser/views/+page.svelte': ''
	});

	// `@root` is the base namespace
	expect(module.apps.root.permissions.documents.read).toBe('documents.read');
	expect(module.apps.root.permissions.cloud.storage.objects.list).toBe(
		'cloud.storage.objects.list'
	);

	// every other app is namespaced with its directory name
	expect(module.apps.Cheque_Parser.permissions.documents.read).toBe('Cheque_Parser:documents.read');
	expect(module.apps.Cheque_Parser.permissions.cloud.storage.buckets.create).toBe(
		'Cheque_Parser:cloud.storage.buckets.create'
	);
});

test('an app without a `@permissions` module has an empty vocabulary', async () => {
	const { module } = await load({
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/shop/views/+page.svelte': ''
	});

	expect(module.apps.root.permissions).toEqual({});
	expect(module.apps.shop.permissions).toEqual({});
});

test('inherits `requires` and applies `page_requires` only to the page it is declared with', async () => {
	const { module } = await load({
		'src/apps/@root/@permissions.js': `export const permissions = ['a.one', 'b.one', 'b.two', 'b.three'];`,
		'src/apps/@root/views/+access.js': `export const requires = ['a.one'];`,
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/@root/views/admin/+access.js': `export const requires = ['b.one']; export const page_requires = ['b.two'];`,
		'src/apps/@root/views/admin/+page.svelte': '',
		'src/apps/@root/views/admin/child/+access.js': `export const requires = ['b.three'];`,
		'src/apps/@root/views/admin/child/+page.svelte': ''
	});

	expect(module.get_required_permissions('/')).toEqual(new Set(['a.one']));
	expect(module.get_required_permissions('/admin')).toEqual(new Set(['a.one', 'b.one', 'b.two']));
	expect(module.get_required_permissions('/admin/child')).toEqual(
		new Set(['a.one', 'b.one', 'b.three'])
	);
});

test('expands wildcards against the app’s vocabulary', async () => {
	const { module } = await load({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+access.js': `export const requires = ['cloud.storage.*'];`,
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/@root/views/all/+access.js': `export const requires = ['*'];`,
		'src/apps/@root/views/all/+page.svelte': ''
	});

	expect(module.get_required_permissions('/')).toEqual(
		new Set([
			'cloud.storage.buckets.create',
			'cloud.storage.buckets.delete',
			'cloud.storage.objects.list'
		])
	);

	expect(module.get_required_permissions('/all')).toEqual(
		new Set([
			'documents.read',
			'documents.write',
			'cloud.storage.buckets.create',
			'cloud.storage.buckets.delete',
			'cloud.storage.objects.list'
		])
	);
});

test('namespaces requirements with the app that declares them', async () => {
	const { module } = await load({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/Cheque_Parser/@permissions.js': PERMISSIONS,
		'src/apps/Cheque_Parser/views/+access.js': `export const requires = ['documents.read'];`,
		'src/apps/Cheque_Parser/views/+page.svelte': '',
		'src/apps/Cheque_Parser/api/+access.js': `export const requires = ['cloud.storage.*'];`,
		'src/apps/Cheque_Parser/api/health/+server.js': 'export function GET() {}'
	});

	expect(module.get_required_permissions('/cheque-parser')).toEqual(
		new Set(['Cheque_Parser:documents.read'])
	);

	// api routes are keyed by their namespaced id, so the two trees can't collide
	expect(module.get_required_permissions('/__api/cheque-parser/health')).toEqual(
		new Set([
			'Cheque_Parser:cloud.storage.buckets.create',
			'Cheque_Parser:cloud.storage.buckets.delete',
			'Cheque_Parser:cloud.storage.objects.list'
		])
	);
});

test('returns `null` for an unknown or unmatched route', async () => {
	const { module } = await load({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+page.svelte': ''
	});

	expect(module.get_required_permissions(null)).toBe(null);
	expect(module.get_required_permissions('/nope')).toBe(null);
});

test('returns a copy of the required permissions', async () => {
	const { module } = await load({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+access.js': `export const requires = ['documents.read'];`,
		'src/apps/@root/views/+page.svelte': ''
	});

	/** @type {Set<string>} */ (module.get_required_permissions('/')).clear();

	expect(module.get_required_permissions('/')).toEqual(new Set(['documents.read']));
});

test('errors when a requirement is not declared in the app’s `@permissions` module', async () => {
	const message = await load_error({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+access.js': `export const requires = ['documents.destroy'];`,
		'src/apps/@root/views/+page.svelte': ''
	});

	expect(message).toMatch('documents.destroy');
	expect(message).toMatch('not declared');
});

test('errors when a wildcard matches nothing', async () => {
	const message = await load_error({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+access.js': `export const requires = ['nope.*'];`,
		'src/apps/@root/views/+page.svelte': ''
	});

	expect(message).toMatch('does not match any permission');
});

test('errors when a wildcard is not a whole trailing segment', async () => {
	const message = await load_error({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+access.js': `export const requires = ['cloud.*.create'];`,
		'src/apps/@root/views/+page.svelte': ''
	});

	expect(message).toMatch('whole trailing segment');
});

test('errors when `page_requires` is used without a `+page`', async () => {
	const message = await load_error({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+access.js': `export const page_requires = ['documents.read'];`,
		'src/apps/@root/views/+layout.svelte': '<slot />',
		'src/apps/@root/views/child/+page.svelte': ''
	});

	expect(message).toMatch('no +page component');
});

test('errors when `page_requires` is declared in a pathless group', async () => {
	const message = await load_error({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/(group)/+access.js': `export const page_requires = ['documents.read'];`,
		'src/apps/@root/views/(group)/child/+page.svelte': ''
	});

	expect(message).toMatch('no +page component');
});

test('errors when a permission is both a namespace and a leaf', async () => {
	const message = await load_error({
		'src/apps/@root/@permissions.js': `export const permissions = ['cloud.storage', 'cloud.storage.buckets.create'];`,
		'src/apps/@root/views/+page.svelte': ''
	});

	expect(message).toMatch('cannot also be a namespace');
});

test('errors when `@permissions` declares a wildcard', async () => {
	const message = await load_error({
		'src/apps/@root/@permissions.js': `export const permissions = ['cloud.storage.*'];`,
		'src/apps/@root/views/+page.svelte': ''
	});

	expect(message).toMatch('Wildcards are only allowed in +access modules');
});

test('writes types that mirror the nesting, and imports the vocabulary', async () => {
	const { root } = await load({
		'src/apps/@root/@permissions.js': PERMISSIONS,
		'src/apps/@root/views/+page.svelte': '',
		'src/apps/Cheque_Parser/@permissions.js': PERMISSIONS,
		'src/apps/Cheque_Parser/views/+page.svelte': ''
	});

	const types = fs.readFileSync(path.join(root, 'node_modules/$app/apps.d.ts'), 'utf8');

	expect(types).toContain(
		`import type { permissions as permissions_1 } from "../../src/apps/Cheque_Parser/@permissions.js";`
	);
	expect(types).toContain(`NestPermissions<(typeof permissions_0)[number], "">`);
	expect(types).toContain(`NestPermissions<(typeof permissions_1)[number], "Cheque_Parser:">`);
	expect(types).toContain(
		'export function get_required_permissions(route_id: RouteId | null): Set<string> | null;'
	);
});
