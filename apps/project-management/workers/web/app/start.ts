// TanStack Start instance — empty options are fine, we just need the
// virtual `#tanstack-start-entry` module to resolve.  Wire in middleware /
// serializationAdapters here in the future.
import { createStart } from '@tanstack/react-start';

export const startInstance = createStart(() => ({}));
