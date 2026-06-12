// The PM test env/D1/KV/R2 mocks live in @allenlabs/pm-core (which owns the Env
// contract and the auth seam they back). Re-exported here so the app's tests
// keep importing `../_setup/env` unchanged.
export {
  makeMemoryAuthDb,
  makeMemoryKV,
  makeMemoryR2,
  makeTestEnv,
  makeAuthState,
  type AuthState,
  buildAuthMock,
} from '@allenlabs/pm-core/testing/env';
