import backend from "../../../workers/visit/index.js";
export default {
  async fetch(request, env) {
    const mode = request.headers.get("x-fixture-mode") || "normal";
    return backend.fetch(request, { ...env, SUPABASE_URL: `https://${mode}.supabase.invalid` });
  }
};
