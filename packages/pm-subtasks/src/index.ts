// @allenlabs/pm-subtasks — parent/child subtask hierarchy for the PM suite.
// A lifecycle feature: it contributes a PmPlugin (validation on create/update +
// done-ratio roll-up) and the underlying impls. Depends only on @allenlabs/pm-core.
export * from './server/subtasks';
export { subtasksPlugin } from './subtasks.plugin';
