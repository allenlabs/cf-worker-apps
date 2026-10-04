// @allenlabs/pm-core — reusable core for the Allen Labs project-management suite.
//
// A thin TanStack Start app (allenlabs' `apps/project-management`, or a private
// tenant's app) consumes this package source-level: it provides the schema,
// pure server-side logic, the plugin host, the auth-adapter seam, and the
// shared utilities, while the app keeps only its routes, server-fn wrappers,
// wrangler/vite config, env, and plugin list.
//
// This first slice exposes the dependency-free `lib/*` utilities. Subsequent
// slices move the db schema/client, ref-data, members/permissions impls, the
// auth seam, and the plugin host in behind this same entry point.
//
// Utilities are also reachable individually via the `./lib/*` subpath export
// (e.g. `@allenlabs/pm-core/lib/format`) for code that wants a narrow import.

export * from './lib/format';
export * from './lib/permissions';
export * from './lib/mentions';
export * from './lib/hmac';
export * from './lib/public-paths';
export * from './lib/board';
