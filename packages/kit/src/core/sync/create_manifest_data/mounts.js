/** @import { AppMount } from 'types' */
import fs from 'node:fs';
import path from 'node:path';
import { posixify } from '../../../utils/os.js';
import * as e from '../../../messages/build-errors.js';

/**
 * The prefix baked into the ids of routes on the `api` tree, mirroring the `/_app` convention
 * used for internal routes. It keeps `RouteId`, `EndpointRouteId` and `Path` unambiguous when
 * the same pathname exists on both origins.
 */
export const API_ID_PREFIX = '/__api';

/** The directories an app can have, and the tree each one is served from. */
const TREES = /** @type {const} */ (['views', 'api']);

/**
 * Normalise an app directory name into a URL prefix, or `''` for `@root`.
 *
 * Camel case boundaries are deliberately *not* split, so `ChequeParser` becomes `/chequeparser`
 * rather than `/cheque-parser`. Runs of whitespace, `_` and `-` all collapse to a single `-`, so
 * `Cheque Parser`, `Cheque_Parser` and `cheque--parser` all become `/cheque-parser`. Only case,
 * whitespace and `_`/`-` differences can make two app names collide.
 *
 * @param {string} name
 * @returns {string}
 */
export function app_prefix(name) {
	if (name === '@root') return '';

	return (
		'/' +
		name
			.toLowerCase()
			.replace(/[\s_-]+/g, '-')
			.replace(/^-+|-+$/g, '')
	);
}

/**
 * The key an app is exposed under in `$app/apps` — its directory name, except for the default
 * app, which is `apps.root` so that it can be read without bracket notation.
 * @param {string} name
 * @returns {string}
 */
export function app_key(name) {
	return name === '@root' ? 'root' : name;
}

/**
 * Discovers every mount in `apps_dir`. Each app contributes a `views` mount and/or an `api`
 * mount, depending on which directories exist.
 *
 * @param {string} apps_dir
 * @param {string} cwd
 * @returns {AppMount[]}
 */
export function create_mounts(apps_dir, cwd) {
	/** @type {AppMount[]} */
	const mounts = [];

	/** @type {Map<string, string>} */
	const prefixes = new Map();

	/** @type {Map<string, string>} */
	const keys = new Map();

	const apps = fs
		.readdirSync(apps_dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	for (const app of apps) {
		const app_dir = path.join(apps_dir, app.name);
		const files = fs.readdirSync(app_dir);

		if (app.name !== '@root') {
			const global_layout = files.find((file) => file === '@layout' || file.startsWith('@layout.'));

			if (global_layout) {
				e.app_global_layout_not_root({
					file: posixify(path.relative(cwd, path.join(app_dir, global_layout)))
				});
			}
		}

		const prefix = app_prefix(app.name);

		const clash = prefixes.get(prefix);
		if (clash !== undefined) {
			e.app_prefix_duplicate({ prefix: prefix || '/', first: clash, second: app.name });
		}
		prefixes.set(prefix, app.name);

		const key = app_key(app.name);

		const key_clash = keys.get(key);
		if (key_clash !== undefined) {
			e.app_root_name_reserved({ app: app.name, reserved: key_clash });
		}
		keys.set(key, app.name);

		let found = false;

		for (const tree of TREES) {
			const dir = path.join(app_dir, tree);
			if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;

			found = true;

			mounts.push({
				app: app.name,
				tree,
				prefix,
				id_prefix: tree === 'api' ? API_ID_PREFIX + prefix : prefix,
				dir,
				base: posixify(path.relative(cwd, dir))
			});
		}

		if (!found) {
			e.app_no_route_directory({
				app: app.name,
				directory: posixify(path.relative(cwd, app_dir))
			});
		}
	}

	return mounts;
}
