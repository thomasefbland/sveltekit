/** @import { ManifestData } from 'types' */
import path from 'node:path';
import { GENERATED_COMMENT } from '../../constants.js';
import { relative_path } from '../../utils/filesystem.js';
import { s } from '../../utils/misc.js';
import { write_if_changed } from './utils.js';
import { app_key } from './create_manifest_data/mounts.js';
import { get_access_files, is_app_route } from './create_manifest_data/index.js';

/**
 * The namespace a permission is prefixed with, to keep permissions declared by different apps
 * from colliding. `@root` is the base namespace, so its permissions are unprefixed.
 * @param {string} app
 */
function namespace(app) {
	return app === '@root' ? '' : `${app}:`;
}

/**
 * Creates the `$app/apps` data module. It is the only place where user-declared permission
 * strings are read, so every expansion happens here, once, at module initialisation — by the
 * time `get_required_permissions` is called the requirements are plain namespaced strings.
 *
 * The requirements are not precomputed during sync because the vocabulary lives in the app's
 * `@permissions` module, which is TypeScript that sync cannot import. Importing it here means
 * Vite handles it, so `.js` and `.ts` both work.
 *
 * @param {string} out
 * @param {ManifestData} manifest_data
 * @param {string} root The project root directory
 */
export function write_app_apps(out, manifest_data, root) {
	/** @type {string[]} */
	const imports = [];

	/** @type {string[]} */
	const vocabularies = [];

	/** @type {Map<string, string>} */
	const permission_identifiers = new Map();

	for (const [index, { app, file }] of manifest_data.permissions.entries()) {
		const identifier = `permissions_${index}`;
		permission_identifiers.set(app, identifier);
		imports.push(
			`import { permissions as ${identifier} } from ${s(relative_path(out, path.resolve(root, file)))};`
		);
		vocabularies.push(`\t${s(app)}: ${identifier}`);
	}

	/** @type {Map<string, string>} */
	const access_identifiers = new Map();

	/** @param {string} file */
	const get_access_identifier = (file) => {
		let identifier = access_identifiers.get(file);

		if (identifier === undefined) {
			identifier = `access_${access_identifiers.size}`;
			access_identifiers.set(file, identifier);
			imports.push(
				`import * as ${identifier} from ${s(relative_path(out, path.resolve(root, file)))};`
			);
		}

		return identifier;
	};

	/** @type {string[]} */
	const apps = [];

	/** @type {Set<string>} */
	const seen = new Set();

	for (const mount of manifest_data.mounts) {
		if (seen.has(mount.app)) continue;
		seen.add(mount.app);

		const identifier = permission_identifiers.get(mount.app);

		apps.push(
			`\t${s(app_key(mount.app))}: { permissions: ${
				identifier ? `nest(${s(mount.app)}, ${identifier})` : '{}'
			} }`
		);
	}

	/** @type {Map<string, string>} */
	const routes = new Map();

	/** @param {import('types').RouteData} route */
	const add = (route) => {
		if (routes.has(route.id)) return;

		const modules = get_access_files(route).map(
			(file) => `[${get_access_identifier(file)}, ${s(file)}]`
		);

		routes.set(
			route.id,
			`\t${s(route.id)}: { app: ${s(route.app)}, modules: [${modules.join(', ')}], own: ${
				route.access !== null
			}, page: ${route.page !== null} }`
		);
	};

	for (const route of manifest_data.routes) {
		if (!is_app_route(route)) continue;

		add(route);

		// a pathless directory (such as a `(group)`) with a `+access` module but no route of its
		// own is dropped from `manifest_data.routes`. It still needs an entry, so that a
		// `page_requires` declared in it is rejected rather than silently ignored
		/** @type {import('types').RouteData | null} */
		let current = route.parent;

		while (current) {
			if (current.access) add(current);
			current = current.parent;
		}
	}

	const code = `${GENERATED_COMMENT}
${imports.join('\n')}

/** The permissions each app declares, in their flat form. */
const vocabularies = {
${vocabularies.join(',\n')}
};

/** The \`+access\` modules that apply to each route, outermost first. */
const access_modules = {
${[...routes.values()].join(',\n')}
};

${runtime}

/**
 * The permissions declared by each app, nested by segment, so that \`apps.X.permissions.a.b\` is
 * the string \`"X:a.b"\`. \`@root\` is exposed as \`apps.root\`, and its permissions are unprefixed.
 */
export const apps = {
${apps.join(',\n')}
};

/** Route id -> the permissions that route requires, already namespaced and expanded. */
const required_permissions = create_required_permissions();

/**
 * Returns the permissions required by a route, or \`null\` if there is no such route.
 *
 * The returned set is a copy — mutating it has no effect on subsequent calls. A route that
 * requires nothing returns an empty set, which is distinct from \`null\` so that a mistyped route
 * id cannot silently pass a naive \`required.every(...)\` check.
 *
 * @param {string | null} route_id
 * @returns {Set<string> | null}
 */
export function get_required_permissions(route_id) {
	if (route_id === null || route_id === undefined) return null;

	const required = required_permissions.get(route_id);
	return required === undefined ? null : new Set(required);
}
`;

	write_if_changed(`${out}/app-apps.js`, code);
}

/**
 * Writes `node_modules/$app/apps.d.ts`. The runtime module nests the permissions by splitting on
 * `.`; this reproduces that nesting in the type system so that the same expression type-checks
 * and autocompletes. The vocabulary is imported from the user's own `@permissions` module rather
 * than duplicated, so it can never drift.
 *
 * @param {ManifestData} manifest_data
 * @param {string} root The project root directory
 */
export function write_app_apps_types(manifest_data, root) {
	const file = path.join(root, 'node_modules/$app/apps.d.ts');
	const dir = path.dirname(file);

	/** @type {string[]} */
	const imports = [];

	/** @type {string[]} */
	const permissions = [];

	/** @type {Map<string, string>} */
	const identifiers = new Map();

	for (const [index, app_permissions] of manifest_data.permissions.entries()) {
		const identifier = `permissions_${index}`;
		identifiers.set(app_permissions.app, identifier);

		// `.js` even for a `.ts` file, so that this doesn't rely on `allowImportingTsExtensions`
		const relative = relative_path(dir, path.resolve(root, app_permissions.file)).replace(
			/\.(?:js|ts)$/,
			'.js'
		);

		imports.push(`import type { permissions as ${identifier} } from ${s(relative)};`);
		permissions.push(`(typeof ${identifier})[number]`);
	}

	/** @type {string[]} */
	const apps = [];

	/** @type {Set<string>} */
	const seen = new Set();

	for (const mount of manifest_data.mounts) {
		if (seen.has(mount.app)) continue;
		seen.add(mount.app);

		const identifier = identifiers.get(mount.app);

		apps.push(
			`\t${s(app_key(mount.app))}: {
\t\tpermissions: ${
				identifier
					? `NestPermissions<(typeof ${identifier})[number], ${s(namespace(mount.app))}>`
					: '{}'
			};
\t};`
		);
	}

	const code = `${GENERATED_COMMENT}

import type { RouteId } from '$app/types';
${imports.join('\n')}

type UnionToIntersection<Union> = (
\tUnion extends unknown ? (argument: Union) => void : never
) extends (argument: infer Intersection) => void
\t? Intersection
\t: never;

type NestedPermission<Path extends string, Value extends string> =
\tPath extends \`\${infer Head}.\${infer Rest}\`
\t\t? { [Key in Head]: NestedPermission<Rest, Value> }
\t\t: { [Key in Path]: Value };

type NestPermissions<Permission extends string, Prefix extends string> = UnionToIntersection<
\tPermission extends unknown ? NestedPermission<Permission, \`\${Prefix}\${Permission}\`> : never
>;

/** Every permission declared by any app, in its flat, un-namespaced form. */
type AllPermissions = ${permissions.join(' | ') || 'never'};

/**
 * A permission requirement. Either an exact permission from an app's \`@permissions\` module, or
 * a wildcard that expands to one or more of them.
 *
 * \`*\` must be a whole trailing segment: \`documents.*\` is valid, \`documents.*.read\` is not.
 * Wildcards are only allowed in \`+access\` modules — a grant is always an exact permission.
 *
 * @example
 * \`\`\`ts
 * import type { PermissionPattern } from '$app/apps';
 *
 * export const requires: PermissionPattern[] = ['documents.*'];
 * \`\`\`
 */
export type PermissionPattern<Permission extends string = AllPermissions> =
\t| Permission
\t| '*'
\t| (Permission extends \`\${infer Head}.\${infer Rest}\`
\t\t\t? \`\${Head}.*\` | \`\${Head}.\${PermissionPattern<Rest>}\`
\t\t\t: never);

/**
 * The permissions declared by each app, nested by segment, so that \`apps.X.permissions.a.b\` is
 * the string \`"X:a.b"\`. \`@root\` is exposed as \`apps.root\`, and its permissions are unprefixed.
 */
export const apps: {
${apps.join('\n')}
};

/**
 * Returns the permissions required by a route, or \`null\` if there is no such route.
 *
 * A route that requires nothing returns an empty set, which is distinct from \`null\` so that a
 * mistyped route id cannot silently pass a naive \`required.every(...)\` check.
 */
export function get_required_permissions(route_id: RouteId | null): Set<string> | null;
`;

	write_if_changed(file, code);
}

/**
 * The helpers the generated module inlines. They are kept as a string because they are only ever
 * executed as part of the user's bundle, never by sync itself.
 */
const runtime = String.raw`
/**
 * @param {string} app
 * @param {string} permission
 */
function namespace(app, permission) {
	return app === '@root' ? permission : app + ':' + permission;
}

/**
 * @param {string} app
 * @param {readonly string[]} permissions
 */
function nest(app, permissions) {
	/** @type {Record<string, any>} */
	const tree = {};

	for (const permission of permissions) {
		if (permission.includes('*')) {
			throw new Error(
				'"' +
					permission +
					'" is declared in the @permissions module of "' +
					app +
					'". Wildcards are only allowed in +access modules, because a grant is always an exact permission.'
			);
		}

		const segments = permission.split('.');
		/** @type {Record<string, any>} */
		let node = tree;

		for (let i = 0; i < segments.length - 1; i += 1) {
			const segment = segments[i];
			const child = node[segment];

			if (typeof child === 'string') {
				throw new Error(
					'"' +
						permission +
						'" cannot be declared in the @permissions module of "' +
						app +
						'", because "' +
						segments.slice(0, i + 1).join('.') +
						'" is already a permission. A permission cannot also be a namespace.'
				);
			}

			node = node[segment] = child ?? {};
		}

		const leaf = segments[segments.length - 1];

		if (typeof node[leaf] === 'object') {
			throw new Error(
				'"' +
					permission +
					'" cannot be declared in the @permissions module of "' +
					app +
					'", because it is already used as a namespace. A permission cannot also be a namespace.'
			);
		}

		node[leaf] = namespace(app, permission);
	}

	return tree;
}

/**
 * Expands wildcard requirements against the app's vocabulary, so that the check at request time
 * is a plain set comparison. The vocabulary is the single source of truth for what exists, which
 * means a typo — in an exact permission or in a wildcard that matches nothing — is caught here.
 *
 * @param {string} app
 * @param {readonly string[]} patterns
 * @param {string} file
 * @returns {string[]}
 */
function expand(app, patterns, file) {
	const vocabulary = vocabularies[app] ?? [];
	/** @type {string[]} */
	const expanded = [];

	for (const pattern of patterns) {
		if (pattern === '*') {
			for (const permission of vocabulary) expanded.push(namespace(app, permission));
			continue;
		}

		if (pattern.endsWith('.*')) {
			const prefix = pattern.slice(0, -1);
			let matched = false;

			for (const permission of vocabulary) {
				if (permission.startsWith(prefix)) {
					expanded.push(namespace(app, permission));
					matched = true;
				}
			}

			if (!matched) {
				throw new Error(
					'"' +
						pattern +
						'" in ' +
						file +
						' does not match any permission declared in the @permissions module of "' +
						app +
						'".'
				);
			}

			continue;
		}

		if (pattern.includes('*')) {
			throw new Error(
				'"' +
					pattern +
					'" in ' +
					file +
					' is not a valid wildcard. A wildcard must be a whole trailing segment, such as "documents.*".'
			);
		}

		if (!vocabulary.includes(pattern)) {
			throw new Error(
				'"' +
					pattern +
					'" in ' +
					file +
					' is not declared in the @permissions module of "' +
					app +
					'".'
			);
		}

		expanded.push(namespace(app, pattern));
	}

	return expanded;
}

function create_required_permissions() {
	/** @type {Map<string, Set<string>>} */
	const required = new Map();

	for (const [id, { app, modules, own, page }] of Object.entries(access_modules)) {
		/** @type {Set<string>} */
		const permissions = new Set();

		for (const [module, file] of modules) {
			if (module.requires === undefined) continue;
			for (const permission of expand(app, module.requires, file)) permissions.add(permission);
		}

		if (own) {
			const [module, file] = modules[modules.length - 1];
			const page_requires = module.page_requires;

			if (page_requires !== undefined) {
				if (!page) {
					throw new Error(
						'"' +
							file +
							'" declares "page_requires", but ' +
							id +
							' has no +page component. Use "requires" instead, or move the module into a directory that has one.'
					);
				}

				for (const permission of expand(app, page_requires, file)) permissions.add(permission);
			}
		}

		required.set(id, permissions);
	}

	return required;
}
`;
