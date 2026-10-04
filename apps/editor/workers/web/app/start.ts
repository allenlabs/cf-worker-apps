// TanStack Start instance — empty options are fine; we just need the virtual
// `#tanstack-start-entry` module to resolve.
import { createStart } from '@tanstack/react-start';

export const startInstance = createStart(() => ({}));
