// @allenlabs/pm-relations — issue relations (relates/blocks/duplicates/precedes/
// copied_to) for the PM suite. Owns the relation vocabulary + a lifecycle plugin
// (validate + wire relations on create, contribute them to issue detail).
export * from './server/relations';
export { relationsPlugin } from './relations.plugin';
