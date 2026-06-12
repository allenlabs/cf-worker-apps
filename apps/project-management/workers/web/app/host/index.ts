// The app's plugin host. Core modules (issues.ts) import this singleton and
// emit lifecycle events through it; the listed plugins react. Registration
// order = dispatch order. A second deployment composes its own host with a
// different plugin list (incl. private plugins) — the core never changes.

import { createPmHost } from './create-host';
import { subtasksPlugin } from '~/plugins/subtasks.plugin';
import { relationsPlugin } from '~/plugins/relations.plugin';
import { labelsPlugin } from '~/plugins/labels.plugin';
import { notificationsPlugin } from '~/plugins/notifications.plugin';

export const host = createPmHost([
  subtasksPlugin,
  relationsPlugin,
  labelsPlugin,
  notificationsPlugin,
]);
