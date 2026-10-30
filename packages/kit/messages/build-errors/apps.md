## app_prefix_duplicate

> `%first%` and `%second%` both resolve to the prefix `%prefix%`

App directory names are lowercased, and `_` is converted to `-`, to produce the URL prefix for every route in that app (`ChequeParser` becomes `/chequeparser`, `Cheque_Parser` becomes `/cheque-parser`). These two directories produce the same prefix, so their routes would collide. Rename one of them.

## app_global_layout_not_root

> `%file%` is a global layout, but only `src/apps/@root` can define one

`@layout.svelte`, `@layout.js` and `@layout.server.js` in `src/apps/@root` wrap every page in every app, on both origins. In any other app, use `views/+layout.svelte` instead, which applies only to that app's `views` routes.

## app_no_route_directory

> `%app%` has neither a `views` nor an `api` directory in `%directory%`

Every app must contain a `views` directory (routes served from your main origin), an `api` directory (routes served from the API origin), or both.

## app_api_file_not_allowed

> `%file%` is not allowed in an `api` directory

The `api` tree is served from a separate origin and only responds with `+server.js` endpoints, so there is nothing to render. Remove the file, or move it into the app's `views` directory.

## app_api_prerender

> `%file%` cannot be prerendered, because it lives in an `api` directory

Prerendered output for both trees is written to the same directory, so a prerendered API endpoint would shadow any page with the same pathname. Remove `export const prerender = true`, or move the endpoint into the app's `views` directory.

## apps_no_routes

> No routes found in `%directory%`

The `src/apps` directory exists, but none of the apps inside it contain any `+page`, `+layout`, `+error` or `+server` files. Add something like `src/apps/@root/views/+page.svelte`.

## app_access_without_permissions

> `%file%` declares permissions, but `%app%` has no `@permissions` module

A `+access` module's requirements are expanded against the vocabulary declared by the app's `@permissions` module, so every app that declares requirements needs one. Create `src/apps/%app%/@permissions.ts` (or `.js`) exporting a `permissions` array.

## app_permissions_prerender

> `%id%` cannot be prerendered, because `%file%` declares permissions for it

Prerendered routes are written to disk and served as static files, so `handle` never runs for them — whatever permission check you perform there would be silently bypassed. Remove `export const prerender = true` from this route, or remove the `+access` module that applies to it.

## app_page_and_endpoint

> `%id%` cannot have both a `+page` and `%file%`

`get_required_permissions` describes a route as a single set of permissions, but a `+page` and a `+server` in the same directory answer the same pathname depending on the request's `Accept` header, so their requirements could differ. Move `%file%` into the app's `api` directory, where the same pathname can have its own `+access` module.

## app_root_name_reserved

> `%app%` conflicts with `%reserved%`, which is exposed as `apps.root`

`src/apps/@root` is the default app, and it is exposed as `apps.root` so that it can be read without bracket notation. An app directory named `root` would therefore collide with it. Rename the directory.
