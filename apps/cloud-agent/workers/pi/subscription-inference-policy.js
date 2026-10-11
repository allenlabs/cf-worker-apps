// Server-owned selection for ordinary inference; the bridge has its own explicit policy.
export function subscriptionInferenceProvider(value) {
  const provider = value === undefined ? "auto" : value;
  if (!["auto", "siwc"].includes(provider)) throw new Error("subscription_inference_policy_invalid");
  return provider;
}
