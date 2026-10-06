import assert from "node:assert/strict";
import { installSubscriptionModels } from "../../workers/pi/subscription-models.js";
import { codexImageRequest } from "../../workers/pi/codex-images-auth.js";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";

const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture`;
const profile = { kind: "codex_image_v1", clientId: "fixture-client", access: token, accountId: "fixture-account" };
const originalFetch = globalThis.fetch;
const html = "<html><body>Unable to load site; fixture-private-marker</body></html>";
const headers = { "content-type": "text/html", "x-request-id": "fixture-request", "cf-ray": "abcdef123-TEST", "cf-mitigated": "challenge", "set-cookie": "fixture-private-marker", "authorization": "Bearer fixture-private-marker" };
const expected = { phase: "image", status: 403, category: "upstream_blocked", contentType: "html", requestId: "fixture-request", rayId: "abcdef123-TEST", challenge: true };
const received = [];
let imageCalls = 0;
try {
  globalThis.fetch = async () => { imageCalls++; return new Response(html, { status: 403, headers }); };
  await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "codex" }, profile, "Fixture prompt", undefined, value => received.push(value)), error => {
    assert.equal(error.message, "image_upstream_blocked", "HTML denial must not require reauthentication");
    assert.deepEqual(error.diagnostic, expected);
    assert(!JSON.stringify(error.diagnostic).includes("fixture-private-marker"));
    return true;
  });
  assert.deepEqual(received, [expected]);
  assert.equal(imageCalls, 1, "no automatic retry");

  for (const [status, code, category] of [[401, "image_auth_needed", "auth_required"], [403, "image_permission_denied", "permission_denied"], [429, "codex_image_http_429", "rate_limited"], [502, "codex_image_http_502", "upstream_error"]]) {
    globalThis.fetch = async () => Response.json({ error: { message: "fixture-private-marker" } }, { status });
    await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "codex" }, profile, "Fixture prompt", undefined, () => { throw new Error("fixture observer failure"); }), error => {
      assert.equal(error.message, code); assert.equal(error.diagnostic.category, category);
      assert.equal(error.diagnostic.status, status); assert.equal(error.diagnostic.contentType, "json");
      return true;
    });
  }
  globalThis.fetch = async () => Response.json({ data: [{ b64_json: "Zml4dHVyZQ==" }] }, { headers: { "x-codex-imagegen-request-id": "fixture-image-request", "x-request-id": "unused-request", "cf-ray": "!".repeat(200) } });
  let successDiagnostic;
  const response = await codexImageRequest({ IMAGE_PROVIDER: "codex" }, profile, "Fixture prompt", undefined, value => { successDiagnostic = value; throw new Error("fixture observer failure"); });
  assert.equal(response.headers.get("x-codex-imagegen-request-id"), "fixture-image-request");
  assert.equal((await response.json()).data[0].b64_json, "Zml4dHVyZQ==");
  assert.deepEqual(successDiagnostic, { ...expected, status: 200, category: "success", contentType: "json", requestId: "fixture-image-request", rayId: null, challenge: false });
  globalThis.fetch = async () => new Response("not JSON", { status: 401, headers: { "content-type": "application/json", "x-request-id": "invalid id", "cf-ray": "a".repeat(129) } });
  await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "codex" }, profile, "Fixture prompt"), error => {
    assert.equal(error.message, "codex_image_http_401"); assert.equal(error.diagnostic.category, "invalid_response");
    assert.equal(error.diagnostic.requestId, null); assert.equal(error.diagnostic.rayId, null);
    return true;
  });

  for (const method of ["stream", "streamSimple"]) {
    let provider, authorized = 0, fetched = 0, originalCallback = 0;
    const diagnostics = [];
    installSubscriptionModels({ setProvider(value) { if (value.id === "openai-codex") provider = value; } }, async () => ({ async codexAccess() { return { access: token }; } }), async () => { authorized++; }, value => { diagnostics.push(value); throw new Error("fixture observer failure"); });
    assert.equal((await provider.auth.apiKey.resolve()).auth.apiKey, token); assert.equal(authorized, 1);
    const controller = new AbortController();
    globalThis.fetch = () => { throw new Error("caller fetch must be preserved"); };
    const events = provider[method](provider.getModels()[0], { messages: [{ role: "user", content: "Synthetic diagnostic check", timestamp: 0 }] }, {
      apiKey: token, signal: controller.signal, transport: "websocket", maxRetries: 0, timeoutMs: 2000,
      fetch: async (url, init) => {
        fetched++; assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
        assert.equal(init.headers.get("accept"), "text/event-stream"); assert.equal(init.signal.aborted, false);
        return new Response(html, { status: 403, headers });
      },
      onResponse(responseInfo, model) { originalCallback++; assert.equal(responseInfo.status, 403); assert.equal(model.provider, "openai-codex"); }
    });
    const streamed = [];
    for await (const event of events) streamed.push(event);
    const result = await events.result();
    assert.equal(fetched, 1); assert.equal(originalCallback, 1);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "codex_upstream_blocked");
    assert(!JSON.stringify(result).includes("fixture-private-marker"), "raw provider HTML must not reach the native journal");
    assert(!JSON.stringify(streamed).includes("fixture-private-marker"), "streamed events and result must both be safe");
    assert.deepEqual(diagnostics, [{ ...expected, phase: "inference" }]);
    assert.deepEqual(result.diagnostic, diagnostics[0]);

    const prefixed = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, fetch: async () => Response.json({ error: { message: `Provider (403): ${html}` } }, { status: 403 }) }).result();
    assert.equal(prefixed.errorMessage, "codex_upstream_blocked");
    assert.equal(prefixed.diagnostic.category, "upstream_blocked"); assert.equal(prefixed.diagnostic.contentType, "html");
    assert(!JSON.stringify(prefixed).includes("fixture-private-marker"));

    for (const raw of [html, `<html>service unavailable; fixture-private-marker</html>`, `<html>context length exceeded; fixture-private-marker</html>`, `<html>500 billing; fixture-private-marker</html>`]) {
      const normalized = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, fetch: async () => new Response(raw, { status: 503, headers }) }).result();
      const original = { stopReason: "error", errorMessage: raw };
      assert.equal(isRetryableAssistantError(normalized), isRetryableAssistantError(original), "native outer retry classification must remain unchanged");
      assert.equal(isContextOverflow(normalized), isContextOverflow(original), "native outer compaction classification must remain unchanged");
      assert(!JSON.stringify(normalized).includes("fixture-private-marker"));
    }

    const callbackFailure = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, fetch: async () => Response.json({}, { status: 401 }), onResponse() { throw new Error("original callback failed"); } }).result();
    assert.equal(callbackFailure.errorMessage, "original callback failed", "existing callback failure behavior stays intact");

    const completed = { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } };
    let attempts = 0;
    const success = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 1, fetch: async () => {
      attempts++;
      return attempts === 1 ? new Response(html, { status: 503, headers: { ...headers, "retry-after-ms": "0" } }) : new Response(`event: ${completed.type}\ndata: ${JSON.stringify(completed)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }).result();
    assert.equal(attempts, 2, "caller maxRetries remains effective"); assert.equal(success.stopReason, "stop"); assert.equal(success.usage.totalTokens, 5);
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    const aborted = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, signal: alreadyAborted.signal, fetch: async () => { assert.fail("aborted request must not fetch"); } }).result();
    assert.equal(aborted.stopReason, "aborted");
  }
  console.log("Codex diagnostics checks passed: typed auth/permission/block errors, safe headers, preserved Pi caller hooks/SSE, no raw HTML persistence or live calls.");
} finally { globalThis.fetch = originalFetch; }
