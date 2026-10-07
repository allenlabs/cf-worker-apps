import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
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
const expected = { phase: "image", status: 403, category: "upstream_blocked", cause: "challenge", contentType: "html", errorBodyFormat: "html", requestId: "fixture-request", rayId: "abcdef123-TEST", challenge: true, cfErrorType: null, cfErrorOriginPresent: false, htmlMarkers: null, htmlTruncated: null };
const received = [];
let imageCalls = 0;
try {
  for (const code of ["1000", "1016", "1101", "1102", "521", "522", "523", "524", "525", "526", "1020", "1009", "1015"]) {
    const value = codexDiagnostic("inference", { status: 403, headers: { "content-type": "text/html", "cf-error-type": code, "cf-error-origin": "fixture-private-marker" } });
    assert.equal(value.cfErrorType, code, "Known error headers retain only the allowlisted code");
    assert.equal(value.cfErrorOriginPresent, true); assert.equal(value.htmlMarkers, null);
    assert.equal(value.cause, "unknown"); assert.equal(value.category, "permission_denied");
    assert(!JSON.stringify(value).includes("fixture-private-marker"));
  }
  for (const type of ["", "unknown", "9999", "fixture-private-marker", "x".repeat(1000)]) {
    const value = codexDiagnostic("inference", { status: 403, headers: { "cf-error-type": type } });
    assert.equal(value.cfErrorType, "other"); assert.equal(value.cfErrorOriginPresent, false);
  }
  const absent = codexDiagnostic("inference", { status: 403 });
  assert.equal(absent.cfErrorType, null); assert.equal(absent.cfErrorOriginPresent, false);
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
    const { requestShape, responseShape, payloadShape, ...responseDiagnostic } = finalDiagnostic;
    assert.deepEqual(responseDiagnostic, { ...expected, phase: "inference", htmlMarkers: [], htmlTruncated: false });
    assert.equal(requestShape.expectedEndpoint, true); assert.equal(requestShape.method, "POST");
    assert.equal(requestShape.modelId, provider.getModels()[0].id);
    assert.deepEqual(requestShape.headers, { authorization: true, account: true, contentType: true, accept: true });
    assert.deepEqual(responseShape, { redirected: false, expectedFinalEndpoint: null });assert.deepEqual(payloadShape, { storeFalse: true, streamTrue: true, inputArray: true, toolSchemaValid: true });
    assert(!JSON.stringify(diagnostics).includes(token)); assert(!JSON.stringify(diagnostics).includes("fixture-account"));
    assert.deepEqual(result.diagnostic, finalDiagnostic);

    const prefixed = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, fetch: async () => Response.json({ error: { message: `Provider (403): ${html}` } }, { status: 403 }) }).result();
    assert.equal(prefixed.errorMessage, "codex_upstream_blocked"); assert.deepEqual(prefixed.diagnostic.htmlMarkers, []);
    assert.equal(prefixed.diagnostic.category, "permission_denied"); assert.equal(prefixed.diagnostic.cause, "unknown"); assert.equal(prefixed.diagnostic.contentType, "json"); assert.equal(prefixed.diagnostic.errorBodyFormat, "html");
    assert(!JSON.stringify(prefixed).includes("fixture-private-marker"));

    const markerCases = [
      ['<html><title> Attention Required! | Cloudflare </title><div id="cf-error-details"><span class="cf-error-code">1020</span>Sorry, you have been blocked fixture-private-marker</div></html>', ["cf_attention_required", "cf_error_details", "cf_error_code", "cf_code_1020", "cf_blocked_phrase"], false],
      ['<html><title> Just a   moment... </title></html>', ["cf_just_a_moment"], false],
      ...["1009", "1015"].map(code => ['<html><span class="other cf-error-code">'+code+'</span></html>', ["cf_error_code", "cf_code_"+code], false]),
      [`<html><!-- <span class="cf-error-code">1020</span> --><script>"Sorry, you have been blocked"</script><p data-note='class="cf-error-code"'>1020 cf-error-details</p></html>`, [], false],
      ['<html><div data-note="<title>Just a moment...</title>"></div></html>', [], false],
      ['<html><div data-note="<title>Attention Required! | Cloudflare</title>"></div></html>', [], false],
      ['<html><span class="cf-error-code">9999</span><title>Unknown fixture-private-marker</title></html>', ["cf_error_code"], false],
      ['<html>' + 'x'.repeat(65536) + '<span class="cf-error-code">1020</span></html>', [], true],
      ['<html>' + '가'.repeat(23000) + '<title>Just a moment...</title></html>', [], true]
    ];
    for (const [raw, markers, truncated] of markerCases) {
      let reads = 0;
      const observed = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, fetch: async () => {
        const response = new Response(raw, { status: 403, headers: { "content-type": "text/html", "cf-error-type": "1020", "cf-error-origin": "fixture-private-marker" } });
        const text = response.text.bind(response); response.text = () => { reads++; return text(); };
        response.clone = () => assert.fail("Diagnostics cannot clone the native response"); return response;
      } }).result();
      assert.equal(reads, 1, "Only native Pi consumes the final response body");
      assert.deepEqual(observed.diagnostic.htmlMarkers, markers); assert.equal(observed.diagnostic.htmlTruncated, truncated);
      assert.equal(observed.diagnostic.cfErrorType, "1020"); assert.equal(observed.diagnostic.cfErrorOriginPresent, true);
      assert.equal(observed.diagnostic.cause, "unknown"); assert.equal(observed.diagnostic.category, "permission_denied");
      assert.equal(observed.errorMessage, "codex_upstream_blocked"); assert(!JSON.stringify(observed).includes("fixture-private-marker"));
    }
    const plainMarker = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, fetch: async () => Response.json({ error: { message: "Sorry, you have been blocked" } }, { status: 403 }) }).result();
    assert.equal(plainMarker.diagnostic.htmlMarkers, null, "Non-HTML errors do not match template markers");

    let payloadCalls = 0, fetchCalls = 0, payloadOverride, finalPayloadJson;
    const redirected = await provider[method]({ ...provider.getModels()[0], baseUrl: "https://chatgpt.com/backend-api/codex/responses?fixture-private-marker" }, { messages: [] }, { apiKey: token, maxRetries: 0, headers: { "x-fixture-private": "fixture-private-marker" }, async onPayload(body, model) { payloadCalls++; assert.equal(this.transport, "sse", "caller retains the native provider-options receiver"); assert.equal(model.provider, "openai-codex"); await Promise.resolve(); payloadOverride = { ...body, store: true, input: "fixture-private-marker", tools: [{ type: "function", name: "fixture_tool", parameters: null }] }; finalPayloadJson = JSON.stringify(payloadOverride); return payloadOverride; }, fetch: async (url, init) => {
      fetchCalls++; assert(url.includes("fixture-private-marker")); assert.equal(init.headers.get("x-fixture-private"), "fixture-private-marker"); assert(init.body instanceof Uint8Array, "Native Pi compression remains enabled"); assert.equal(init.headers.get("content-encoding"), "zstd"); assert.equal(zstdDecompressSync(init.body).toString(), finalPayloadJson, "Diagnostic observation leaves the exact caller override and native compressed bytes unchanged"); assert.equal(payloadOverride.store, true); payloadOverride.store = false; payloadOverride.input = []; payloadOverride.tools = [];
      const response = new Response(html, { status: 403, headers: { "content-type": "text/html" } });
      Object.defineProperties(response, { redirected: { value: true }, url: { value: "https://example.invalid/login?fixture-private-marker" } });
      return response;
    } }).result();
    assert.equal(payloadCalls, 1); assert.equal(fetchCalls, 1);
    assert.equal(redirected.diagnostic.requestShape.expectedEndpoint, false);
    assert.deepEqual(redirected.diagnostic.responseShape, { redirected: true, expectedFinalEndpoint: false });
    assert.equal(redirected.diagnostic.cause, "unknown"); assert.equal(redirected.diagnostic.contentType, "html");
    assert.deepEqual(redirected.diagnostic.requestShape.body, { parsedJson: null, storeFalse: null, streamTrue: null, inputArray: null, toolSchemaValid: null }, "Wire parsing stays unknown for compressed bytes"); assert.deepEqual(redirected.diagnostic.payloadShape, { storeFalse: false, streamTrue: true, inputArray: false, toolSchemaValid: false }, "Separate immutable structure observes the final caller payload before compression");
    assert(!JSON.stringify(redirected.diagnostic).includes("fixture-private-marker"));

    let mutationCalls = 0, mutatedPayloadJson;
    const mutated = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, async onPayload(body) {
      mutationCalls++; assert.equal(this.transport, "sse"); await Promise.resolve(); body.store = true; body.input = "fixture-private-marker"; body.tools = [{ type: "function", name: "fixture_tool", parameters: null }]; mutatedPayloadJson = JSON.stringify(body); return undefined;
    }, fetch: async (url, init) => { assert.equal(zstdDecompressSync(init.body).toString(), mutatedPayloadJson, "Undefined hook result retains in-place mutation"); return Response.json({}, { status: 401 }); } }).result();
    assert.equal(mutationCalls, 1); assert.deepEqual(mutated.diagnostic.payloadShape, { storeFalse: false, streamTrue: true, inputArray: false, toolSchemaValid: false });

    let accessorCalls = 0;
    const accessor = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, onPayload(body) { Object.defineProperty(body, "store", { enumerable: true, configurable: true, get() { accessorCalls++; return false; } }); }, fetch: async (url, init) => { assert.equal(accessorCalls, 1, "Only native serialization reads accessors"); assert.equal(JSON.parse(zstdDecompressSync(init.body).toString()).store, false); return Response.json({}, { status: 401 }); } }).result();
    assert.deepEqual(accessor.diagnostic.payloadShape, { storeFalse: null, streamTrue: true, inputArray: true, toolSchemaValid: true }); assert.equal(accessorCalls, 1);
    let toJSONCalls = 0;
    const customSerialized = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, onPayload() { return { toJSON() { toJSONCalls++; return { store: false, stream: true, input: [], tools: [] }; } }; }, fetch: async (url, init) => { assert.equal(toJSONCalls, 1, "Only native serialization invokes toJSON"); assert.equal(zstdDecompressSync(init.body).toString(), '{"store":false,"stream":true,"input":[],"tools":[]}'); return Response.json({}, { status: 401 }); } }).result();
    const unknownPayload = { storeFalse: null, streamTrue: null, inputArray: null, toolSchemaValid: null };
    assert.deepEqual(customSerialized.diagnostic.payloadShape, unknownPayload); assert.equal(toJSONCalls, 1);
    const unobservable = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, onPayload() { return new Proxy({ stream: true, input: [], tools: [] }, { getOwnPropertyDescriptor(target, name) { if (name === "store") throw Error("fixture-private-marker"); return Reflect.getOwnPropertyDescriptor(target, name); } }); }, fetch: async (url, init) => { assert.equal(zstdDecompressSync(init.body).toString(), '{"stream":true,"input":[],"tools":[]}'); return Response.json({}, { status: 401 }); } }).result();
    assert.deepEqual(unobservable.diagnostic.payloadShape, unknownPayload, "Observation failure cannot prevent native serialization/fetch"); assert(!JSON.stringify(unobservable.diagnostic).includes("fixture-private-marker"));
    const nullOverride = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, onPayload() { return null; }, fetch: async (url, init) => { assert.equal(zstdDecompressSync(init.body).toString(), "null", "Null is an explicit override, not an undefined fallback"); return Response.json({}, { status: 401 }); } }).result();
    assert.deepEqual(nullOverride.diagnostic.payloadShape, unknownPayload);
    for (const reject of [false, true]) {
      const beforeFailure = diagnostics.length;
      const payloadFailure = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, maxRetries: 0, onPayload() { const error = Error("fixture original payload callback failed"); if (reject) return Promise.reject(error); throw error; }, fetch: async () => assert.fail("Failed payload hook cannot fetch") }).result();
      assert.equal(payloadFailure.errorMessage, "fixture original payload callback failed"); assert.equal(diagnostics.length, beforeFailure, "Caller errors are preserved without fabricating a response diagnostic");
    }
    assert(!JSON.stringify(diagnostics).includes("fixture-private-marker")); assert(!JSON.stringify(diagnostics).includes(token)); assert(!JSON.stringify(diagnostics).includes("fixture-account"));

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
    assert.deepEqual(retried.at(-1).htmlMarkers, null, "A successful retry retains no stale final-HTML marker");
    assert.notEqual(retried[0].requestShape.attemptId, retried[1].requestShape.attemptId, "transport attempts have distinct IDs");assert.deepEqual(retried[0].payloadShape,retried[1].payloadShape,"Native retries keep the same pre-compression structure snapshot");
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    const aborted = await provider[method](provider.getModels()[0], { messages: [] }, { apiKey: token, signal: alreadyAborted.signal, fetch: async () => { assert.fail("aborted request must not fetch"); } }).result();
    assert.equal(aborted.stopReason, "aborted");
  }
  console.log("Codex diagnostics checks passed: allowlisted CF headers and bounded final-HTML markers, wire/body formats, confirmed challenge vs unknown cause, safe wire request shape/redirects and separate immutable pre-compression structure, preserved Pi caller mutation/async override/errors/accessors/toJSON/retries/compressed SSE; no live calls.");
} finally { globalThis.fetch = originalFetch; }
