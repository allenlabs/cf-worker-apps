import { createFileRoute } from '@tanstack/react-router';

// Tiny health probe used by the deploy smoke check.  Public (listed in
// __root.tsx PUBLIC_PATHS) so it's reachable without an SSO bounce.  We
// render a component rather than throwing a Response so TanStack's default
// error boundary doesn't wrap it in HTML — the deploy script grep'ing for
// "ok" still finds it even though it's wrapped in the SSR shell.
export const Route = createFileRoute('/health')({
  component: HealthPage,
});

function HealthPage() {
  return <pre data-testid="health">ok</pre>;
}
