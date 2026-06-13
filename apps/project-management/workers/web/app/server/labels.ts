// Thin TanStack Start server-fn wrappers for issue labels. The logic lives in
// @allenlabs/pm-labels; this file binds the SSR runtime (getDb /
// requirePermission). Exercised by the wrangler integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  createLabelSchema,
  createLabelImpl,
  deleteLabelImpl,
  listLabelsImpl,
  setIssueLabelsImpl,
} from '@allenlabs/pm-labels';
import { getDb, requirePermission } from './auth-runtime.server';

export const listLabels = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => listLabelsImpl(getDb(), data.projectId));

export const createLabel = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => createLabelSchema.parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_categories');
    return createLabelImpl(getDb(), data);
  });

export const deleteLabel = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_categories');
    return deleteLabelImpl(getDb(), data.id);
  });

export const setIssueLabels = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ issueId: z.number(), projectId: z.number(), labelIds: z.array(z.number()) }).parse(d),
  )
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'edit_issues');
    return setIssueLabelsImpl(getDb(), data.issueId, data.labelIds);
  });

/* v8 ignore stop */
