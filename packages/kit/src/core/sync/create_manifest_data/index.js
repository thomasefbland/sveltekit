/** @import { ValidatedConfig } from 'types' */
import { lookup } from '../../../utils/mime.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolve_entry, walk } from '../../../utils/filesystem.js';
import { posixify } from '../../../utils/os.js';
import { parse_route_id, validate_route_id_params } from '../../../utils/routing.js';
import { runtime_directory } from '../../utils.js';
import * as e from '../../../messages/build-errors.js';
import * as w from '../../../messages/build-warnings.js';
import { prevent_conflicts } from './conflict.js';
import { sort_routes } from './sort.js';
import { create_mounts } from './mounts.js';
import {
	create_node_analyser,
	get_page_options
} from '../../../exports/vite/static_analysis/index.js';

const component_name_pattern = /^\+(?:(page(?:@(.*))?)|(layout(?:@(.*))?)|(error))$/;

const module_name_pattern =
	/^\+(?:(server)|(page(?:(@[a-zA-Z0-9_-]*))?(\.server)?)|(layout(?:(@[a-zA-Z0-9_-]*))?(\.server)?))$/;

/**
 * Generates the manifest data used for the client-side manifest and types generation.
 * @param {ValidatedConfig} config
 * @param {string} root
 * @param {string} [fallback] Where to look for fallback components
 * @returns {import('types').ManifestData}
 */
export default function create_manifest_data(
	config,
	root,
	fallback = `${runtime_directory}/components`
) {
	const assets = create_assets(config);
	const hooks = create_hooks(config, root);
	const params = resolve_params(config, root);
	const { nodes, routes, mounts, permissions, root_layout, root_layout_dir } =
		create_routes_and_nodes(root, config, fallback);

	return {
		assets,
		hooks,
		params,
		nodes,
		routes,
		mounts,
		permissions,
		root_layout,
		root_layout_dir,
		api_host: config.router.api_host
	};
}

/**
 * Whether this route has a `+page`. Independent of `is_endpoint_route` — a route can be both.
 * @param {import('types').RouteData} route
 * @returns {boolean}
 */
export function is_page_route(route) {
	return !!route.page;
}

/**
 * Whether this route has a `+server`. Independent of `is_page_route` — a route can be both.
 * @param {import('types').RouteData} route
 * @returns {boolean}
 */
export function is_endpoint_route(route) {
	return !!route.endpoint;
}

/**
 * Whether the router can match this route. `manifest_data.routes` also contains entries for
 * directories with layouts or errors, which never reach `event.route.id`.
 * @param {import('types').RouteData} route
 * @returns {boolean}
 */
export function is_app_route(route) {
	return is_page_route(route) || is_endpoint_route(route);
}

/**
 * Returns a list of files in the `static` directory.
 * @param {import('types').ValidatedConfig} config
 */
export function create_assets(config) {
	if (!fs.existsSync(config.files.assets)) return [];

	return [...walk(config.files.assets)].map((file) => ({
		file,
		type: lookup(file) || null
	}));
}

/**
 * @param {import('types').ValidatedConfig} config
 * @param {string} cwd
 */
function create_hooks(config, cwd) {
	const client = resolve_entry(config.files.hooks.client, config.moduleExtensions);
	const server = resolve_entry(config.files.hooks.server, config.moduleExtensions);
	const universal = resolve_entry(config.files.hooks.universal, config.moduleExtensions);

	return {
		client: client && posixify(path.relative(cwd, client)),
		server: server && posixify(path.relative(cwd, server)),
		universal: universal && posixify(path.relative(cwd, universal))
	};
}

/**
 * @param {import('types').ValidatedConfig} config
 * @param {string} cwd
 */
function resolve_params(config, cwd) {
	const params_file = resolve_entry(config.files.params, config.moduleExtensions);
	return params_file ? posixify(path.relative(cwd, params_file)) : null;
}

/**
 * @param {string} cwd
 * @param {import('types').ValidatedConfig} config
 * @param {string} fallback
 */
function create_routes_and_nodes(cwd, config, fallback) {
	/** @type {import('types').RouteData[]} */
	let routes = [];

	const valid_extensions = [...config.extensions, ...config.moduleExtensions];

	/** @type {import('types').PageNode[]} */
	const nodes = [];

	const apps_dir = config.files.apps ? path.resolve(cwd, config.files.apps) : null;
	const use_apps = !!apps_dir && fs.existsSync(apps_dir);

	/**
	 * In `apps` mode every `src/apps/<App>/{views,api}` directory is its own mount, and every mount
	 * is walked with `parent = null` — layout isolation is the default rather than something you
	 * opt into. In legacy mode there's a single mount backed by `files.routes`.
	 * @type {import('types').AppMount[]}
	 */
	const mounts = use_apps
		? create_mounts(/** @type {string} */ (apps_dir), cwd)
		: [
				{
					app: '@root',
					tree: 'views',
					prefix: '',
					id_prefix: '',
					dir: config.files.routes,
					base: posixify(path.relative(cwd, config.files.routes))
				}
			];

	/**
	 * `src/apps/@root/@layout.*`, which wraps every page in every app, on both trees.
	 * @type {import('types').PageNode | null}
	 */
	let root_layout = null;

	/** @type {string | null} */
	let root_layout_dir = null;

	/** @type {import('types').PageNode | null} */
	let root_error = null;

	if (use_apps) {
		const app_root = path.join(/** @type {string} */ (apps_dir), '@root');

		const component = resolve_entry(path.join(app_root, '@layout'), config.extensions);
		const universal = resolve_entry(path.join(app_root, '@layout'), config.moduleExtensions);
		const server = resolve_entry(path.join(app_root, '@layout.server'), config.moduleExtensions);

		root_layout_dir = posixify(path.relative(cwd, app_root));
		root_layout = {
			depth: 0,
			component: posixify(path.relative(cwd, component ?? `${fallback}/layout.svelte`)),
			global: true,
			child_pages: []
		};

		if (universal) root_layout.universal = posixify(path.relative(cwd, universal));
		if (server) root_layout.server = posixify(path.relative(cwd, server));
	}

	/**
	 * Every app's `@permissions` module. It is not inside a `views`/`api` directory, so the walker
	 * never sees it — it's resolved from the app directory itself.
	 * @type {import('types').AppPermissions[]}
	 */
	const permissions = [];

	if (use_apps) {
		/** @type {Set<string>} */
		const seen = new Set();

		for (const mount of mounts) {
			if (seen.has(mount.app)) continue;
			seen.add(mount.app);

			const file = resolve_entry(
				path.join(/** @type {string} */ (apps_dir), mount.app, '@permissions'),
				config.moduleExtensions
			);

			if (file) {
				permissions.push({ app: mount.app, file: posixify(path.relative(cwd, file)) });
			}
		}
	}

	// create route data by processing files in `src/apps/<App>/{views,api}` (or `src/routes`)
	if (mounts.length > 0) {
		/**
		 * @param {import('types').AppMount} mount
		 * @param {number} depth
		 * @param {string} dir_id The path within the mount, `''` for the mount's root.
		 * @param {string} segment
		 * @param {import('types').RouteData | null} parent
		 */
		const walk = (mount, depth, dir_id, segment, parent) => {
			// `dir_id` is the path within the mount, without a leading slash (`''` at its root)
			const id = dir_id ? `${mount.prefix}/${dir_id}` : mount.prefix || '/';

			// the route's id, which is namespaced on the `api` tree so that the same pathname can
			// exist on both origins without the `RouteId` union becoming ambiguous
			const route_id = dir_id ? `${mount.id_prefix}/${dir_id}` : mount.id_prefix || '/';

			const unescaped = id.replace(/\[([ux])\+([^\]]+)\]/gi, (match, type, code) => {
				if (match !== match.toLowerCase()) {
					e.route_escape_uppercase({ id });
				}

				if (!/[0-9a-f]+/.test(code)) {
					e.route_escape_invalid({ id });
				}

				if (type === 'x') {
					if (code.length !== 2) {
						e.route_escape_hex_length({ id });
					}

					return String.fromCharCode(parseInt(code, 16));
				} else {
					if (code.length < 4 || code.length > 6) {
						e.route_escape_unicode_length({ id });
					}

					return String.fromCodePoint(parseInt(code, 16));
				}
			});

			if (/\]\[/.test(unescaped)) {
				e.route_params_adjacent({ id });
			}

			if (count_occurrences('[', id) !== count_occurrences(']', id)) {
				e.route_unbalanced_brackets({ id });
			}

			if (/#/.test(segment)) {
				// Vite will barf on files with # in them
				e.route_hash_character({ id, suggestion: id.replace(/#/g, '[x+23]') });
			}

			if (/\[\.\.\.[\w-]+\]\/\[\[/.test(id)) {
				e.route_optional_after_rest({ id });
			}

			if (/\[\[\.\.\./.test(id)) {
				e.route_optional_rest({ id });
			}

			const invalid_param = validate_route_id_params(id);
			if (invalid_param !== undefined) {
				e.route_param_invalid({ param: invalid_param, id });
			}

			const { pattern, params } = parse_route_id(id);

			/** @type {import('types').RouteData} */
			const route = {
				id: route_id,
				dir: dir_id ? path.posix.join(mount.base, dir_id) : mount.base,
				tree: mount.tree,
				app: mount.app,
				parent,

				segment,
				pattern,
				params,

				layout: null,
				error: null,
				leaf: null,
				access: null,
				page: null,
				endpoint: null
			};

			// important to do this before walking children, so that child
			// routes appear later
			routes.push(route);

			// if we don't do this, the route map becomes unwieldy to console.log
			Object.defineProperty(route, 'parent', { enumerable: false });

			const dir = path.join(mount.dir, dir_id);

			// We sort the entries because `readdirSync` order is not guaranteed and differs
			// between runtimes (e.g. Node returns entries alphabetically, Bun in directory
			// order). Node indices are assigned from this traversal order, so without sorting
			// the SSR and client manifests can disagree, causing hydration mismatches.
			const files = fs
				.readdirSync(dir, { withFileTypes: true })
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
				.map((entry) => ({
					is_dir: entry.isSymbolicLink()
						? fs.statSync(path.join(dir, entry.name)).isDirectory()
						: entry.isDirectory(),
					name: entry.name
				}));

			// process files first
			for (const file of files) {
				if (file.is_dir) continue;

				const ext = valid_extensions.find((ext) => file.name.endsWith(ext));
				if (!ext) continue;

				if (!file.name.startsWith('+')) {
					const name = file.name.slice(0, -ext.length);
					const pattern = config.extensions.includes(ext)
						? component_name_pattern
						: module_name_pattern;

					// check if it is a valid route filename but missing the + prefix
					if (pattern.test(`+${name}`)) {
						w.route_file_prefix_missing({
							corrected: `+${file.name}`,
							file: path.join(dir, file.name)
						});
					}

					continue;
				}

				// allow e.g. `+page.stories.svelte` or `+server.test.ts`
				if (
					file.name.includes('.test.') ||
					file.name.includes('.spec.') ||
					file.name.includes('.stories.')
				) {
					continue;
				}

				if (file.name.endsWith('.d.ts')) {
					let name = file.name.slice(0, -5);
					const ext = valid_extensions.find((ext) => name.endsWith(ext));
					if (ext) name = name.slice(0, -ext.length);

					if (
						name === '+access' ||
						component_name_pattern.test(name) ||
						module_name_pattern.test(name)
					) {
						continue;
					}
				}

				const project_relative = posixify(path.relative(cwd, path.join(dir, file.name)));

				// `+access` declares the permissions a route requires. It is a plain module rather
				// than a route file, so it must be handled before `analyze`, which rejects anything
				// it doesn't recognise. Permissions are an `apps`-mode concept — in legacy mode the
				// file is reserved, exactly as it was before this feature existed.
				if (use_apps && config.moduleExtensions.some((ext) => file.name === `+access${ext}`)) {
					if (route.access) {
						duplicate_files('access module', route.access);
					}

					route.access = project_relative;
					continue;
				}

				const item = analyze(
					project_relative,
					file.name,
					config.extensions,
					config.moduleExtensions
				);

				if (config.router.type === 'hash' && item.kind === 'server') {
					e.route_server_file_hash_router({ file: project_relative });
				}

				// the `api` tree is endpoints only — there is nothing to render on that origin
				if (mount.tree === 'api' && (item.kind === 'component' || item.is_page || item.is_layout)) {
					e.app_api_file_not_allowed({ file: project_relative });
				}

				/**
				 * @param {string} type
				 * @param {string} existing_file
				 * @returns {never}
				 */
				function duplicate_files(type, existing_file) {
					e.route_duplicate_files({
						type,
						directory: `${mount.base}${dir_id || '/'}`,
						existing: path.basename(existing_file),
						file: file.name
					});
				}

				if (item.kind === 'component') {
					if (item.is_error) {
						route.error = {
							depth,
							component: project_relative
						};
					} else if (item.is_layout) {
						if (!route.layout) {
							route.layout = { depth, child_pages: [] };
						} else if (route.layout.component) {
							duplicate_files('layout component', route.layout.component);
						}

						route.layout.component = project_relative;
						if (item.uses_layout !== undefined) route.layout.parent_id = item.uses_layout;
					} else {
						if (!route.leaf) {
							route.leaf = { depth };
						} else if (route.leaf.component) {
							duplicate_files('page component', route.leaf.component);
						}

						route.leaf.component = project_relative;
						if (item.uses_layout !== undefined) route.leaf.parent_id = item.uses_layout;
					}
				} else if (item.is_layout) {
					if (!route.layout) {
						route.layout = { depth, child_pages: [] };
					} else if (route.layout[item.kind]) {
						duplicate_files(
							item.kind + ' layout module',
							/** @type {string} */ (route.layout[item.kind])
						);
					}

					route.layout[item.kind] = project_relative;
				} else if (item.is_page) {
					if (!route.leaf) {
						route.leaf = { depth };
					} else if (route.leaf[item.kind]) {
						duplicate_files(
							item.kind + ' page module',
							/** @type {string} */ (route.leaf[item.kind])
						);
					}

					route.leaf[item.kind] = project_relative;
				} else {
					if (route.endpoint) {
						duplicate_files('endpoint', route.endpoint.file);
					}

					route.endpoint = {
						file: project_relative,
						page_options: null // will be filled later
					};
				}
			}

			// then handle children
			for (const file of files) {
				if (file.is_dir) {
					walk(mount, depth + 1, path.posix.join(dir_id, file.name), file.name, route);
				}
			}
		};

		for (const mount of mounts) {
			if (fs.existsSync(mount.dir)) {
				walk(mount, 0, '', '', null);
			} else if (!use_apps) {
				// If there's no routes directory, we'll just create a single empty route. This ensures the root layout and
				// error components are included in the manifest, which is needed for subsequent build/dev commands to work
				routes.push({
					id: '/',
					dir: mount.base,
					tree: 'views',
					app: mount.app,
					segment: '',
					pattern: /^$/,
					params: [],
					parent: null,
					layout: null,
					error: null,
					leaf: null,
					access: null,
					page: null,
					endpoint: null
				});
			}
		}
	}

	if (use_apps) {
		if (!routes.some((route) => route.leaf || route.error || route.layout || route.endpoint)) {
			e.apps_no_routes({
				directory: posixify(path.relative(cwd, /** @type {string} */ (apps_dir)))
			});
		}
	} else if (fs.existsSync(config.files.routes) && routes.length === 1) {
		const root = routes[0];
		if (!root.leaf && !root.error && !root.layout && !root.endpoint) {
			e.routes_not_found();
		}
	}

	prevent_conflicts(routes);

	if (use_apps) {
		// a requirement can only be expanded against the app's own vocabulary, so a `+access`
		// module without a `@permissions` module is always a mistake
		for (const route of routes) {
			if (!route.access) continue;

			if (!permissions.some((app_permissions) => app_permissions.app === route.app)) {
				e.app_access_without_permissions({ file: route.access, app: route.app });
			}
		}
	}

	// In `apps` mode the root layout is `src/apps/@root/@layout.*`, which wraps every page in
	// every app. Otherwise, fall back to injecting the default layout and error components into
	// the first route, which is the root route of the single mount.
	if (root_layout) {
		root_error = {
			depth: 0,
			component: posixify(path.relative(cwd, `${fallback}/error.svelte`))
		};

		nodes.push(root_layout, root_error);
	} else {
		const root = routes[0];

		if (!root.layout?.component) {
			if (!root.layout) root.layout = { depth: 0, child_pages: [] };
			root.layout.component = posixify(path.relative(cwd, `${fallback}/layout.svelte`));
		}

		if (!root.error?.component) {
			if (!root.error) root.error = { depth: 0, parent: root.layout };
			root.error.component = posixify(path.relative(cwd, `${fallback}/error.svelte`));
		}
	}

	// populate the page nodes list
	// we do layouts/errors first as they are more likely to be reused,
	// and smaller indexes take fewer bytes. also, this guarantees that
	// the default error/layout are 0/1
	for (const route of routes) {
		if (route.layout) {
			if (!route.layout?.component) {
				route.layout.component = posixify(path.relative(cwd, `${fallback}/layout.svelte`));
			}
			nodes.push(route.layout);
		}
		if (route.error) nodes.push(route.error);
	}

	for (const route of routes) {
		if (route.leaf) nodes.push(route.leaf);
	}

	const indexes = new Map(nodes.map((node, i) => [node, i]));

	const node_analyser = create_node_analyser(cwd);

	// add the related layout, page, and error nodes for a route
	for (const route of routes) {
		if (!route.leaf) continue;

		route.page = {
			layouts: [],
			errors: [],
			leaf: /** @type {number} */ (indexes.get(route.leaf))
		};

		/** @type {import('types').RouteData | null} */
		let current_route = route;
		let current_node = route.leaf;
		let parent_id = route.leaf.parent_id;

		while (current_route) {
			if (parent_id === undefined || current_route.segment === parent_id) {
				if (current_route.layout || current_route.error) {
					route.page.layouts.unshift(
						current_route.layout ? indexes.get(current_route.layout) : undefined
					);
					route.page.errors.unshift(
						current_route.error ? indexes.get(current_route.error) : undefined
					);
				}

				if (current_route.layout) {
					/** @type {import('types').PageNode[]} */ (current_route.layout.child_pages).push(
						route.leaf
					);
					current_node.parent = current_node = current_route.layout;
					parent_id = current_node.parent_id;
				} else {
					parent_id = undefined;
				}
			}

			current_route = current_route.parent;
		}

		if (parent_id !== undefined) {
			e.route_layout_segment_missing({
				file: /** @type {string} */ (current_node.component),
				segment: parent_id
			});
		}
	}

	if (root_layout && root_error) {
		const root_layout_index = /** @type {number} */ (indexes.get(root_layout));
		const root_error_index = /** @type {number} */ (indexes.get(root_error));
		const root_layout_node = /** @type {import('types').PageNode} */ (root_layout);

		for (const route of routes) {
			if (!route.page) continue;

			// `@layout` wraps every page, regardless of which app it belongs to
			route.page.layouts.unshift(root_layout_index);
			route.page.errors.unshift(root_error_index);

			// ...and is the parent of each app's outermost layout, so that `LayoutData`
			// flows from `@layout.*` into every page's generated `$types`
			/** @type {import('types').PageNode | null} */
			let node = route.leaf;
			while (node?.parent) node = node.parent;
			if (node && node !== root_layout) node.parent = root_layout;

			/** @type {import('types').PageNode[]} */ (root_layout_node.child_pages).push(
				/** @type {import('types').PageNode} */ (route.leaf)
			);
		}
	}

	// remove route objects with no route file
	routes = routes.filter((route) => route.endpoint || route.leaf || route.layout || route.error);

	// add parents to error nodes so that we can compute which page options apply to them
	for (const route of routes) {
		if (!route.error) continue;

		// the global layout is the parent of every app's error chain
		if (root_layout && route.tree === 'views' && !route.error.parent) {
			route.error.parent = root_layout;
		}

		/** @type {import('types').RouteData | null} */
		let current_route = route;
		while (current_route) {
			if (current_route.layout) {
				route.error.parent = current_route.layout;
				break;
			}
			current_route = current_route.parent;
		}
	}

	// compute the final page options for each page node
	for (const node of nodes) {
		node.page_options = node_analyser.get_page_options(node);
	}

	for (const route of routes) {
		if (route.endpoint) {
			route.endpoint.page_options = get_page_options(route.endpoint.file, cwd);

			// a prerendered endpoint is written to the same output directory as the `views` tree,
			// so it would shadow any page with the same pathname
			if (route.tree === 'api' && route.endpoint.page_options?.prerender) {
				e.app_api_prerender({ file: route.endpoint.file });
			}
		}

		// a route in `apps` mode maps to exactly one set of requirements, so it cannot serve both a
		// page and an endpoint — `Accept` would decide which one answers, and the requirements of
		// the two could differ
		if (use_apps && route.page && route.endpoint) {
			e.app_page_and_endpoint({ id: route.id, file: route.endpoint.file });
		}

		if (route.page && route.endpoint) {
			const page = nodes[route.page.leaf];
			if (page.page_options?.prerender || route.endpoint.page_options?.prerender) {
				const endpoint_file = route.endpoint.file.split('/').pop();

				e.route_prerender_page_and_endpoint({
					id: route.id,
					file: /** @type {string} */ (endpoint_file)
				});
			}
		}

		// prerendered output is served as a static file, so `handle` never runs for it — any
		// permission check performed there would be silently bypassed
		const access_files = get_access_files(route);

		if (is_app_route(route) && access_files.length > 0) {
			const prerender = route.page
				? nodes[route.page.leaf].page_options?.prerender
				: route.endpoint?.page_options?.prerender;

			if (prerender) {
				e.app_permissions_prerender({
					id: route.id,
					file: access_files[access_files.length - 1]
				});
			}
		}
	}

	return {
		nodes,
		routes: sort_routes(routes),
		mounts,
		permissions,
		root_layout,
		root_layout_dir
	};
}

/**
 * The `+access` modules that apply to a route, outermost first. `requires` is inherited down the
 * tree, so a route's requirements are the union of its own module and those of its ancestors.
 * @param {import('types').RouteData} route
 * @returns {string[]}
 */
export function get_access_files(route) {
	/** @type {string[]} */
	const files = [];

	/** @type {import('types').RouteData | null} */
	let current = route;

	while (current) {
		if (current.access) files.unshift(current.access);
		current = current.parent;
	}

	return files;
}

/**
 * Determine if and how the file is relevant to the routing system.
 * @param {string} project_relative
 * @param {string} file
 * @param {string[]} component_extensions
 * @param {string[]} module_extensions
 * @returns {import('./types.js').RouteFile}
 */
function analyze(project_relative, file, component_extensions, module_extensions) {
	const component_extension = component_extensions.find((ext) => file.endsWith(ext));
	if (component_extension) {
		const name = file.slice(0, -component_extension.length);
		const match = component_name_pattern.exec(name);
		if (!match) {
			e.route_file_reserved({ file: project_relative });
		}

		return {
			kind: 'component',
			is_page: !!match[1],
			is_layout: !!match[3],
			is_error: !!match[5],
			uses_layout: match[2] ?? match[4]
		};
	}

	const module_extension = module_extensions.find((ext) => file.endsWith(ext));
	if (module_extension) {
		const name = file.slice(0, -module_extension.length);
		const match = module_name_pattern.exec(name);
		if (!match) {
			e.route_file_reserved({ file: project_relative });
		} else if (match[3] || match[6]) {
			e.route_named_layout_in_module({
				layout: match[3] || match[6],
				name: file,
				file: project_relative
			});
		}

		const kind = match[1] || match[4] || match[7] ? 'server' : 'universal';

		return {
			kind,
			is_page: !!match[2],
			is_layout: !!match[5]
		};
	}

	e.route_file_reserved({ file: project_relative });
}

/**
 * @param {string} needle
 * @param {string} haystack
 */
function count_occurrences(needle, haystack) {
	let count = 0;
	for (let i = 0; i < haystack.length; i += 1) {
		if (haystack[i] === needle) count += 1;
	}
	return count;
}
