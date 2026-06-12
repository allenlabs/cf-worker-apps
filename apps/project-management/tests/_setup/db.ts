// The PM test database + helpers live in @allenlabs/pm-core (which owns the
// schema and the migration ledger they're built from). Re-exported here so the
// app's tests keep importing `../_setup/db` unchanged.
export {
  type TestDB,
  makeTestDb,
  insertUser,
  insertProject,
  addManager,
} from '@allenlabs/pm-core/testing/db';
