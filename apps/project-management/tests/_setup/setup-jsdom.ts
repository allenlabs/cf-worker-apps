// Setup for the jsdom environment (component tests).
//
// jsdom replaces several Node globals with its own implementations.  For tests
// that touch jose/WebCrypto we override them back to Node's so that
// `instanceof Uint8Array` checks across realms still work.
import { webcrypto } from 'node:crypto';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util';

globalThis.TextEncoder = NodeTextEncoder;
// @ts-expect-error overriding jsdom's TextDecoder so jose's Uint8Array checks work
globalThis.TextDecoder = NodeTextDecoder;

if (typeof globalThis.crypto?.subtle === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
