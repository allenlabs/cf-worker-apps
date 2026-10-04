// Setup for the Node environment.  Node already exposes TextEncoder,
// crypto.subtle, and fetch globally, so no polyfills are needed — we
// just want vitest's globals.
import 'vitest';
