// @allenlabs/pm-search — full-text search across issues + wiki for the PM suite.
// A standalone feature: depends only on @allenlabs/pm-core (schema, db, auth
// context). The consuming app calls searchImpl from a route loader; there is no
// lifecycle plugin and no createServerFn wrapper to host.
export * from './server/search';
