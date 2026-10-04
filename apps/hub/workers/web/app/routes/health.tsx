import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/health')({
  component: () => <pre data-testid="health">ok</pre>,
});
