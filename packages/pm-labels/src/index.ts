// @allenlabs/pm-labels — free-form issue labels for the PM suite. Owns the label
// impls + a lifecycle plugin (apply labels chosen at creation; contribute the
// issue's labels to the detail payload). Depends only on @allenlabs/pm-core.
export * from './server/labels';
export { labelsPlugin } from './labels.plugin';
