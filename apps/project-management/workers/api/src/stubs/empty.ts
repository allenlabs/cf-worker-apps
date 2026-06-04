// Stub for TanStack Start SSR virtual modules that get transitively pulled in
// by web/app/server/* (createServerFn wrappers import auth-runtime.server).
// The API worker never executes those SSR code paths; this satisfies the
// bundler so the pure *Impl functions can be reused.
export default {};
