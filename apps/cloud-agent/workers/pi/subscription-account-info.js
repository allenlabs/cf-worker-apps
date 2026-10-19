const encoder = new TextEncoder();
const WEEK = 7 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export function subscriptionIdentity(status) {
  const identity = status.identityVerified === true ? status.identity : null;
  return identity ? { name: identity.name, email: identity.email, planType: identity.planType, workspaceName: identity.workspace?.title ?? null, organizationNames: identity.organizations?.map(item => item.title).filter(Boolean) ?? null, verifiedAt: identity.verifiedAt } : null;
}

export function subscriptionInfoHistory(record, now = Date.now()) {
  return (record?.history ?? []).filter(sample => {
    const at = Date.parse(sample.checkedAt);
    return at > now - WEEK && at <= now;
  }).slice(-168);
}

export function retainSubscriptionInfo(previous, key, value, now = Date.now()) {
  const record = previous?.key === key ? previous : null;
  const history = subscriptionInfoHistory(record, now);
  const successful = value.usage.status === "available";
  const usage = value.usage;
  const windows = [usage.primaryWindow, usage.secondaryWindow, ...(usage.additionalWindows ?? []).flatMap(item => [item.primaryWindow, item.secondaryWindow])];
  if (successful && windows.some(window => typeof window?.usedPercent === "number")) {
    const sample = { checkedAt: value.checkedAt, planType: usage.planType, primaryWindow: usage.primaryWindow, secondaryWindow: usage.secondaryWindow, ...(usage.additionalWindows?.length ? { additionalWindows: usage.additionalWindows } : {}) };
    const hour = Math.floor(Date.parse(value.checkedAt) / HOUR);
    const previousHour = Math.floor(Date.parse(history.at(-1)?.checkedAt) / HOUR);
    if (previousHour === hour) history.pop();
    history.push(sample);
  }
  const retained = { key, snapshot: successful ? value : record?.snapshot ?? null, lastAttempt: value, history: history.slice(-168) };
  // ponytail: retain at most 168 hourly samples for seven days and 90 KiB before sealing;
  // a longer or denser series needs separate storage to stay below the 128 KiB DO value limit.
  while (encoder.encode(JSON.stringify(retained)).length > 90 * 1024 && retained.history.length) retained.history.shift();
  return retained;
}
