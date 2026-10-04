// Relay worker.  Two surfaces:
//
//   1.  `queue(batch)` — runs when the ingest worker pushes RelayJobs onto the
//       `webhook-events` queue.  For each job we spawn a Workflow run that
//       handles the per-subscriber fan-out + retry.
//   2.  `RelayWorkflow` — Cloudflare Workflow that delivers an event to each
//       subscriber with exponential backoff between attempts.
//
// Pure helpers (deliverOnce, base64ToBytes) live in `./delivery.ts` so they
// can be unit-tested without the cloudflare:workers runtime.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { RelayJob } from '../../shared/types';
import { deliverOnce } from './delivery';

interface Env {
  RELAY_WORKFLOW: Workflow;
  USER_AGENT: string;
}

// Workflow steps are persisted; if the worker dies between steps Cloudflare
// resumes from the last checkpoint.  Each `step.do(...)` block is the
// retry unit.
export class RelayWorkflow extends WorkflowEntrypoint<Env, RelayJob> {
  override async run(event: WorkflowEvent<RelayJob>, step: WorkflowStep): Promise<void> {
    const job = event.payload;
    const userAgent = this.env.USER_AGENT;

    for (const subscriber of job.subscribers) {
      await step.do(
        `deliver:${subscriber.id}`,
        {
          retries: {
            limit: job.maxAttempts,
            delay: `${job.initialBackoffMs}ms`,
            backoff: 'exponential',
          },
        },
        async () => {
          const result = await deliverOnce(job.event, subscriber, 1, userAgent);
          if (!result.ok) {
            throw new Error(
              `delivery failed for ${subscriber.id}: status=${result.status} err=${result.error ?? ''}`,
            );
          }
          return result;
        },
      );
    }
  }
}

export default {
  // Queue consumer — turns each RelayJob into a Workflow run.
  async queue(batch: MessageBatch<RelayJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await env.RELAY_WORKFLOW.create({ params: msg.body });
        msg.ack();
      } catch (err) {
        console.error(`[relay] failed to start workflow: ${err}`);
        msg.retry({ delaySeconds: 30 });
      }
    }
  },

  // Tiny health endpoint so you can curl the worker directly.
  async fetch(req: Request, _env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    return new Response('webhook-relay worker', { status: 200 });
  },
};
