import assert from "node:assert/strict";
import { installSubscriptionModels } from "../../workers/pi/subscription-models.js";
import { codexImageRequest } from "../../workers/pi/codex-images-auth.js";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { codexDiagnostic, codexRequestShape } from "../../workers/pi/codex-http.js";

const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture`;
const profile = { kind: "codex_image_v1", clientId: "fixture-client", access: token, accountId: "fixture-account" };
const originalFetch = globalThis.fetch;
const html = "<html><body>Unable to load site; fixture-private-marker</body></html>";
const headers = { "content-type": "text/html", "x-request-id": "fixture-request", "cf-ray": "abcdef123-TEST", "cf-mitigated": "challenge", "set-cookie": "fixture-private-marker", "authorization": "Bearer fixture-private-marker" };
const expected = { phase: "image", status: 403, category: "upstream_blocked", cause: "challenge", contentType: "html", errorBodyFormat: "html", requestId: "fixture-request", rayId: "abcdef123-TEST", challenge: true };
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
  assert.deepEqual(received, [{ ...expected, errorBodyFormat: null }, expected]);
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
  assert.deepEqual(successDiagnostic, { ...expected, status: 200, category: "success", cause: null, contentType: "json", errorBodyFormat: null, requestId: "fixture-image-request", rayId: null, challenge: false });
  globalThis.fetch = async () => new Response("not JSON", { status: 401, headers: { "content-type": "application/json", "x-request-id": "invalid id", "cf-ray": "a".repeat(129) } });
  await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "codex" }, profile, "Fixture prompt"), error => {
    assert.equal(error.message, "codex_image_http_401"); assert.equal(error.diagnostic.category, "invalid_response");
    assert.equal(error.diagnostic.requestId, null); assert.equal(error.diagnostic.rayId, null);
    return true;
  });

  for (const status of [200, 401, 403, 404, 503]) {
    const observed = codexDiagnostic("inference", { status, headers: { "content-type": "text/html" } });
    assert.equal(observed.challenge, false);
    assert.equal(observed.cause, "unknown");
    assert.equal(observed.category, status === 200 ? "invalid_response" : status === 403 ? "permission_denied" : "upstream_error");
    assert.equal(observed.contentType, "html");
    assert.equal(observed.errorBodyFormat, null);
  }
  for (const response of [new Response(html, { status: 403, headers: { "content-type": "text/html" } }), Response.json({ error: { message: html } }, { status: 403 })]) {
    globalThis.fetch = async () => response;
    await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "codex" }, profile, "Fixture prompt"), error => {
      assert.equal(error.message, "image_upstream_blocked", "legacy image error code is preserved for sniffed HTML");
      assert.equal(error.diagnostic.category, "permission_denied");
      assert.equal(error.diagnostic.cause, "unknown");
      assert.equal(error.diagnostic.contentType, response.headers.get("content-type").startsWith("text/html") ? "html" : "json");
      assert.equal(error.diagnostic.errorBodyFormat, "html");
      return true;
    });
  }
  for (const type of ["text/plain", null]) for (const body of [JSON.stringify({ error: { message: "fixture-private-marker" } }), "fixture-private-marker"]) {
    globalThis.fetch = async () => { const response = new Response(body, { status: 403 }); type === null ? response.headers.delete("content-type") : response.headers.set("content-type", type); return response; };
    await assert.rejects(codexImageRequest({ IMAGE_PROVIDER: "codex" }, profile, "Fixture prompt"), error => {
      assert.equal(error.message, "codex_image_http_403", "non-JSON wire errors preserve their public image code");
      assert.equal(error.diagnostic.category, "permission_denied"); assert.equal(error.diagnostic.cause, "unknown");
      assert.equal(error.diagnostic.contentType, type === null ? "missing" : "other"); assert.equal(error.diagnostic.errorBodyFormat, null);
      return true;
    });
  }
  const shape = codexRequestShape("https://chatgpt.com/backend-api/codex/responses", { method: "POST", headers: { authorization: "Bearer fixture-private-marker", "chatgpt-account-id": "fixture-account", "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ model: "fixture-model", store: false, stream: true, input: [{ content: "fixture-private-marker" }], tools: [{ type: "function", name: "fixture_tool", parameters: { type: "object", properties: { private: { description: "fixture-private-marker" } } } }] }) }, "fixture-model");
  assert.equal(shape.expectedEndpoint, true); assert.equal(shape.method, "POST"); assert.equal(shape.modelId, "fixture-model");
  assert.match(shape.attemptId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(shape.headers, { authorization: true, account: true, contentType: true, accept: true });
  assert.deepEqual(shape.body, { parsedJson: true, storeFalse: true, streamTrue: true, inputArray: true, toolSchemaValid: true });
  assert(!JSON.stringify(shape).includes("fixture-private-marker")); assert(!JSON.stringify(shape).includes("fixture-account"));
  for (const body of [new Uint8Array([1, 2]), new ReadableStream({ start(controller) { controller.close(); } })]) assert.deepEqual(codexRequestShape("https://chatgpt.com/backend-api/codex/responses", { body }, "fixture-model").body, { parsedJson: null, storeFalse: null, streamTrue: null, inputArray: null, toolSchemaValid: null });
  const request = new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "fixture-private-marker" });
  assert.equal(codexRequestShape(request, undefined, "fixture-model").body.parsedJson, null);
  assert.equal(request.bodyUsed, false, "request-body observation must not consume caller input");
  const invalid = codexRequestShape("https://chatgpt.com/backend-api/codex/responses?fixture-private-marker", { method: "fixture-private-marker", body: "not JSON" }, "fixture-model");
  assert.equal(invalid.expectedEndpoint, false); assert.equal(invalid.method, "other");
  assert.equal(invalid.body.parsedJson, false); assert.equal(invalid.body.toolSchemaValid, null);
  assert.deepEqual(invalid.headers, { authorization: false, account: false, contentType: false, accept: false });
  for (const [tools, valid] of [[[], true], [[{ type: "function", name: "fixture_tool", parameters: null }], false], [[{ type: "custom", name: "fixture_tool", format: { type: "grammar", syntax: "lark", definition: "fixture-private-marker" } }], true], [[{ type: "unknown", name: "fixture_tool" }], null]]) assert.equal(codexRequestShape("https://chatgpt.com/backend-api/codex/responses", { body: JSON.stringify({ tools }) }, "fixture-model").body.toolSchemaValid, valid);

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
    const finalDiagnostic = diagnostics.at(-1);
    const { requestShape, responseShape, ...responseDiagnostic } = finalDiagnostic;
    assert.deepEqual(responseDiagnostic, { ...expected, phase: "inference" });
    assert.equal(requestShape.expectedEndpoint, true); assert.equal(requestShape.method, "POST");
    assert.equal(requestShape.modelId, provider.getModels()[0].id);
    assert.deepEqual(requestShape.headers, { authorization: true, account: true, contentType: true, accept: true });
    assert.deepEqual(responseShape, { redirected: false, expectedFinalEndpoint: null });
    assert(!JSON.stringify(diagnostics).includes(token)); assert(!JSON.stringify(diagnostics).includes("fixture-account"));
    assert.deepEqual(result.diagnostic, finalDiagnostic);

    const prefixed = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, fetch: async () => Response.json({ error: { message: `Provider (403): ${html}` } }, { status: 403 }) }).result();
    assert.equal(prefixed.errorMessage, "codex_upstream_blocked");
    assert.equal(prefixed.diagnostic.category, "permission_denied"); assert.equal(prefixed.diagnostic.cause, "unknown"); assert.equal(prefixed.diagnostic.contentType, "json"); assert.equal(prefixed.diagnostic.errorBodyFormat, "html");
    assert(!JSON.stringify(prefixed).includes("fixture-private-marker"));

    let payloadCalls = 0, fetchCalls = 0, stringBody;
    const redirected = await provider[method]({ ...provider.getModels()[0], baseUrl: "https://chatgpt.com/backend-api/codex/responses?fixture-private-marker" }, { messages: [] }, { apiKey: token, maxRetries: 0, headers: { "x-fixture-private": "fixture-private-marker" }, onPayload(body) { payloadCalls++; return { ...body, store: true, input: "fixture-private-marker", tools: [{ type: "function", name: "fixture_tool", parameters: null }] }; }, fetch: async (url, init) => {
      fetchCalls++; assert(url.includes("fixture-private-marker")); assert.equal(init.headers.get("x-fixture-private"), "fixture-private-marker"); stringBody = typeof init.body === "string";
      const response = new Response(html, { status: 403, headers: { "content-type": "text/html" } });
      Object.defineProperties(response, { redirected: { value: true }, url: { value: "https://example.invalid/login?fixture-private-marker" } });
      return response;
    } }).result();
    assert.equal(payloadCalls, 1); assert.equal(fetchCalls, 1);
    assert.equal(redirected.diagnostic.requestShape.expectedEndpoint, false);
    assert.deepEqual(redirected.diagnostic.responseShape, { redirected: true, expectedFinalEndpoint: false });
    assert.equal(redirected.diagnostic.cause, "unknown"); assert.equal(redirected.diagnostic.contentType, "html");
    assert.deepEqual(redirected.diagnostic.requestShape.body, stringBody ? { parsedJson: true, storeFalse: false, streamTrue: true, inputArray: false, toolSchemaValid: false } : { parsedJson: null, storeFalse: null, streamTrue: null, inputArray: null, toolSchemaValid: null });
    assert(!JSON.stringify(redirected.diagnostic).includes("fixture-private-marker"));

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
    const beforeRetry = diagnostics.length;
    const success = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 1, fetch: async () => {
      attempts++;
      return attempts === 1 ? new Response(html, { status: 503, headers: { ...headers, "retry-after-ms": "0" } }) : new Response(`event: ${completed.type}\ndata: ${JSON.stringify(completed)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }).result();
    assert.equal(attempts, 2, "caller maxRetries remains effective"); assert.equal(success.stopReason, "stop"); assert.equal(success.usage.totalTokens, 5);
    const retried = diagnostics.slice(beforeRetry);
    assert.deepEqual(retried.map(value => value.status), [503, 200]);
    assert.notEqual(retried[0].requestShape.attemptId, retried[1].requestShape.attemptId, "transport attempts have distinct IDs");
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    const aborted = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, signal: alreadyAborted.signal, fetch: async () => { assert.fail("aborted request must not fetch"); } }).result();
    assert.equal(aborted.stopReason, "aborted");
  }
  console.log("Codex diagnostics checks passed: wire/body formats, confirmed challenge vs unknown cause, safe request shape/redirects, preserved Pi caller hooks/retries/SSE; no live calls.");
} finally { globalThis.fetch = originalFetch; }
