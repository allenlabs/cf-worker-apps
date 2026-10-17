const MAX_BODY_BYTES = 128 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim() !== "";
const optionalText = value => value == null || text(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const unavailable = (reason, httpStatus = null) => ({ status: "unavailable", reason, httpStatus });

async function readJson(url, profile) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  let reader;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${profile.access}`,
        "ChatGPT-Account-ID": profile.accountId,
        "User-Agent": "cloud-agent/1",
        Accept: "application/json",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status !== 200) return unavailable("http_error", response.status);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return unavailable("invalid_content_type", response.status);
    }
    const charset = contentType.match(/;\s*charset\s*=\s*"?([^;"\s]+)/i)?.[1];
    if (charset && !/^utf-?8$/i.test(charset)) return unavailable("invalid_encoding", response.status);
    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
      return unavailable("response_too_large", response.status);
    }
    if (!response.body) return unavailable("invalid_json", response.status);
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let body = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) return unavailable("response_too_large", response.status);
      try {
        body += decoder.decode(value, { stream: true });
      } catch {
        return unavailable("invalid_encoding", response.status);
      }
    }
    try {
      body += decoder.decode();
    } catch {
      return unavailable("invalid_encoding", response.status);
    }
    try {
      return { status: "available", value: JSON.parse(body) };
    } catch {
      return unavailable("invalid_json", response.status);
    }
  } catch {
    return unavailable(controller.signal.aborted ? "timeout" : "network_error", response?.status ?? null);
  } finally {
    clearTimeout(timeout);
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}

function accountInfo(result, accountId) {
  if (result.status !== "available") return result;
  const payload = result.value;
  if (!object(payload) || (!Array.isArray(payload.accounts) && !object(payload.accounts))) {
    return unavailable("unsupported_response", 200);
  }
  const accounts = Array.isArray(payload.accounts)
    ? payload.accounts
    : Object.values(payload.accounts).map(entry => object(entry) && object(entry.account)
      ? { ...entry.account, id: entry.account.account_id }
      : null);
  if (accounts.some(entry => !object(entry) || !text(entry.id)
    || !optionalText(entry.name) || !optionalText(entry.structure) || !optionalText(entry.plan_type))) {
    return unavailable("unsupported_response", 200);
  }
  const matches = accounts.filter(entry => entry.id === accountId);
  if (matches.length !== 1) return unavailable(matches.length ? "duplicate_account" : "account_not_found", 200);
  const selected = matches[0];
  return {
    status: "available",
    httpStatus: 200,
    workspaceName: selected.name ?? null,
    structure: selected.structure ?? null,
    planType: selected.plan_type ?? null,
  };
}

function usageInfo(result, accountId) {
  if (result.status !== "available") return result;
  const payload = result.value;
  if (!object(payload) || !text(payload.plan_type)) return unavailable("unsupported_response", 200);
  if (Object.hasOwn(payload, "account_id") && payload.account_id !== accountId) {
    return unavailable("account_mismatch", 200);
  }
  const rateLimit = payload.rate_limit;
  if (rateLimit != null && (!object(rateLimit) || typeof rateLimit.allowed !== "boolean"
    || typeof rateLimit.limit_reached !== "boolean")) return unavailable("unsupported_response", 200);
  for (const window of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    if (window != null && (!object(window) || ["used_percent", "limit_window_seconds", "reset_after_seconds", "reset_at"]
      .some(key => window[key] != null && !integer(window[key])))) return unavailable("unsupported_response", 200);
  }
  const credits = payload.credits;
  if (credits != null && (!object(credits) || typeof credits.has_credits !== "boolean"
    || typeof credits.unlimited !== "boolean" || (credits.balance != null
      && (typeof credits.balance !== "string" || !/^\d+(?:\.\d+)?$/.test(credits.balance))))) {
    return unavailable("unsupported_response", 200);
  }
  const windowInfo = window => window == null ? null : {
    usedPercent: window.used_percent ?? null,
    windowSeconds: window.limit_window_seconds ?? null,
    resetAt: window.reset_at ?? null,
  };
  return {
    status: "available",
    httpStatus: 200,
    planType: payload.plan_type,
    allowed: rateLimit?.allowed ?? null,
    limitReached: rateLimit?.limit_reached ?? null,
    primaryWindow: windowInfo(rateLimit?.primary_window),
    secondaryWindow: windowInfo(rateLimit?.secondary_window),
    credits: credits == null ? null : {
      hasCredits: credits.has_credits,
      unlimited: credits.unlimited,
      balance: credits.balance ?? null,
    },
  };
}

export async function readCodexAccountInfo(profile) {
  const checkedAt = new Date().toISOString();
  if (!object(profile) || !text(profile.access) || !text(profile.accountId)
    || /[\r\n]/.test(profile.access + profile.accountId)) {
    return { checkedAt, account: unavailable("invalid_profile"), usage: unavailable("invalid_profile") };
  }
  const [account, usage] = await Promise.all([
    readJson("https://chatgpt.com/backend-api/wham/accounts/check", profile),
    readJson("https://chatgpt.com/backend-api/wham/usage", profile),
  ]);
  return { checkedAt, account: accountInfo(account, profile.accountId), usage: usageInfo(usage, profile.accountId) };
}
