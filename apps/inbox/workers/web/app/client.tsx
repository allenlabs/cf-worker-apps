/// <reference types="vite/client" />
import { StartClient } from '@tanstack/react-start/client';
import { hydrateRoot } from 'react-dom/client';

hydrateRoot(document, <StartClient />);

// Best-effort service-worker registration for offline-capture queue.  The
// SW file is a no-op stub for now (drained by future versions).  Errors
// here never block the SPA — a worker that can't register is harmless.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* swallow — installing a SW is best-effort. */
  });
}
