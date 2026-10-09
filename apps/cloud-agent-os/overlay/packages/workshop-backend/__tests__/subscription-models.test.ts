import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import type { AiModelConfig, PublicApi } from "@gadgets/workshop-shared/api";
import { getGatewayModels as getDeploymentModels } from "../src/ai-gateway.js";
import { AdminSettings } from "../src/admin-settings.js";
import { serializeAdminConfig } from "../src/admin-config.js";
import {
  DEFAULT_ADMIN_CONFIG,
  type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";
import { LanguageModelGatekeeper } from "../src/ai-models.js";
import server from "../src/server.js";
import "./test-worker.js";
declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  }
}

const MODEL = "gpt-6.1-sol",
  USER = "one@example.invalid",
  OTHER = "two@example.invalid";
const PROFILE = { type: "agent" as const, id: MODEL, name: "Codex subscription" };
const CONFIG: AiModelConfig = { provider: "openai", model: MODEL, apiToken: "" };
let count = 0;
function managed(config: Partial<AdminConfig> = {}) {
  const values = new Map<string, string>([
    [".adminConfig", serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...config })],
  ]);
  return {
    ...env,
    CODEX_BRIDGE_MANAGEMENT: "admin",
    CODEX_BRIDGE: {
      infer() {
        throw Error("Unexpected inference");
      },
    },
    CODEX_BRIDGE_MODEL: MODEL,
    CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([USER, OTHER]),
    BLUEPRINTS: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
  } as unknown as Cloudflare.Env;
}
function getGatewayModels(deployment: Cloudflare.Env, userId?: string) {
  return getDeploymentModels(deployment, userId, async () =>
    JSON.parse((await deployment.BLUEPRINTS.get(".adminConfig"))!),
  );
}
async function inUser<T>(
  id: string,
  f: (u: import("../src/user.js").UserDurableObject) => Promise<T>,
  config: Partial<AdminConfig> = {},
  legacy = false,
) {
  if (!legacy)
    await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""), async (admin) => {
      const original = admin.env;
      admin.env = managed(config);
      try {
        await admin.updateAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...config });
      } finally {
        admin.env = original;
      }
    });
  return runInDurableObject(env.TEST_USER.getByName(id), async (user) => {
    const original = user.env;
    user.env = legacy ? env : managed(config);
    try {
      await user.loginOrCreateViaGatekeeper(id, true);
      return await f(user);
    } finally {
      user.env = original;
    }
  });
}
function settings() {
  const stub = env.TEST_USER_DIRECTORY.getByName(`subscription-admin-${++count}`);
  let current: string | null = null,
    fail = false;
  const deployment = {
    ...managed(),
    BLUEPRINTS: {
      get: async () => current,
      put: async (_key: string, value: string) => {
        if (fail) throw Error("KV unavailable");
        current = value;
      },
    },
  } as unknown as Cloudflare.Env;
  return {
    deployment,
    current: () => current,
    fail: () => {
      fail = true;
    },
    inDo: <T>(f: (a: AdminSettings) => T | Promise<T>) =>
      runInDurableObject(stub, (_u, state) => f(new AdminSettings(state, deployment))),
  };
}
describe("admin-managed subscription models", () => {
  it("uses the persisted verified actor when a user DO is reopened from its serialized ID", async () => {
    const actor = `restored-${crypto.randomUUID()}@example.invalid`;
    const namedId = env.TEST_USER.idFromName(actor);
    const restoredId = env.TEST_USER.idFromString(namedId.toString());
    expect(restoredId.name).toBeUndefined();
    const deployment = { ...managed(), CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([actor]) };
    await runInDurableObject(env.TEST_USER.get(restoredId), async (user, state) => {
      expect(state.id.name).toBeUndefined();
      await user.loginOrCreateViaGatekeeper(actor, true);
      await user.setOwnDisplayName("denied@example.invalid");
      await user.setOwnCommitEmail("other@example.invalid");
      expect((await user.whoami()).id).toBe(actor);
      const original = user.env;
      user.env = deployment;
      try {
        expect(await user.listModels()).toEqual([PROFILE]);
        expect((await user.getChatContext(MODEL)).aiModel?.config).toEqual(CONFIG);
        await user.setQuickModel(MODEL);
        expect((await user.getChatContext(MODEL)).quickModel).toEqual(CONFIG);
      } finally {
        user.env = original;
      }
    });
  });
  it("does not authorize an uncreated named object through its default profile", async () => {
    const actor = `uncreated-${crypto.randomUUID()}@example.invalid`;
    await runInDurableObject(env.TEST_USER.getByName(actor), async (user) => {
      const original = user.env;
      user.env = {
        ...managed(),
        CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([actor, "user@example.com"]),
      };
      try {
        expect(await user.listModels()).toEqual([]);
      } finally {
        user.env = original;
      }
    });
  });

  it("offers one shared fixed model without duplicate personal setup", async () => {
    const first = await getGatewayModels(managed(), USER),
      second = await getGatewayModels(managed(), OTHER);
    expect(first?.list()).toEqual([PROFILE]);
    expect(second?.list()).toEqual([PROFILE]);
    expect(first?.userModels).toBe(false);
    expect(first?.resolve(MODEL)?.config).toEqual(CONFIG);
    expect(first?.all.map((m) => m.id)).toEqual([MODEL]);
  });
  it("offers and resolves nothing to missing or denied actors", async () => {
    for (const id of [undefined, "denied@example.invalid"]) {
      const models = await getGatewayModels(managed(), id);
      expect(models?.list()).toEqual([]);
      expect(models?.resolve(MODEL)).toBeUndefined();
    }
  });
  it("reserves the disabled fixed ID without offering or resolving it", async () => {
    const models = await getGatewayModels(managed({ modelModes: { [MODEL]: "disabled" } }), USER);
    expect(models?.all.map((m) => m.id)).toEqual([MODEL]);
    expect(models?.list()).toEqual([]);
    expect(models?.resolve(MODEL)).toBeUndefined();
  });
  it("rejects missing binding, unknown model, or invalid allowlist", async () => {
    for (const change of [
      { CODEX_BRIDGE: undefined },
      { CODEX_BRIDGE_MODEL: "unknown-fixture" },
      { CODEX_BRIDGE_ALLOWED_USER_IDS: "[]" },
    ]) {
      await expect(getGatewayModels({ ...managed(), ...change }, USER)).rejects.toThrow();
    }
  });
  it("keeps hidden models resolvable without offering them", async () => {
    const models = await getGatewayModels(managed({ modelModes: { [MODEL]: "hidden" } }), USER);
    expect(models?.list()).toEqual([]);
    expect(models?.resolve(MODEL)?.config).toEqual(CONFIG);
  });
  it("rejects non-boolean availability without writing settings", async () => {
    const fixture = settings();
    await fixture.inDo(async (admin) => {
      await expect(
        admin.setSubscriptionModelEnabled("false" as unknown as boolean),
      ).rejects.toThrow("boolean");
      expect(admin.getAdminConfig().modelModes).toEqual({});
    });
    expect(fixture.current()).toBeNull();
  });
  it("fails closed without an authoritative admin reader", async () => {
    await expect(getDeploymentModels(managed(), USER)).rejects.toThrow("authoritative");
  });
  it("uses authoritative disable even when its KV mirror still says enabled", async () => {
    const models = await getDeploymentModels(managed(), USER, async () => ({
      ...DEFAULT_ADMIN_CONFIG,
      modelModes: { [MODEL]: "disabled" },
    }));
    expect(models?.list()).toEqual([]);
    expect(models?.resolve(MODEL)).toBeUndefined();
  });
  it("leaves default and explicit user-management mode unchanged", async () => {
    expect(
      await getGatewayModels({ ...managed(), CODEX_BRIDGE_MANAGEMENT: "user" }, USER),
    ).toBeNull();
    expect(
      await getGatewayModels({ ...managed(), CODEX_BRIDGE_MANAGEMENT: undefined }, USER),
    ).toBeNull();
  });
  it("blocks personal mutation and builtin deletion while keeping previous records", async () => {
    await inUser(
      USER,
      async (user) => {
        await user.addModel(
          { type: "agent", id: "old-personal", name: "Personal" },
          { ...CONFIG, model: "old-personal" },
        );
        await user.setQuickModel("old-personal");
        await user.setPreferredModel("old-personal");
      },
      {},
      true,
    );
    await inUser(USER, async (user) => {
      expect(await user.listModels()).toEqual([PROFILE]);
      await expect(user.addModel({ ...PROFILE, id: "new" }, CONFIG)).rejects.toThrow("disabled");
      await expect(user.updateModel({ ...PROFILE, id: "old-personal" }, CONFIG)).rejects.toThrow(
        "disabled",
      );
      await expect(user.deleteModel(MODEL)).rejects.toThrow("built-in");
      await expect(user.getModelConfig("old-personal")).rejects.toThrow("disabled");
      await expect(user.deleteModel("old-personal")).rejects.toThrow("disabled");
      expect(await user.getPreferredModel()).toBe("old-personal");
      expect(await user.getQuickModel()).toBeNull();
      expect((await user.getChatContext(MODEL)).quickModel).toBeUndefined();
    });
    await inUser(
      USER,
      async (user) => {
        expect(await user.getQuickModel()).toBe("old-personal");
        expect((await user.listModels()).map((m) => m.id)).toContain("old-personal");
      },
      {},
      true,
    );
  });
  it("honors personal quick/preferred selection without default title inference", async () => {
    await inUser(OTHER, async (user) => {
      expect((await user.getChatContext(MODEL)).quickModel).toBeUndefined();
      await user.setQuickModel(MODEL);
      expect((await user.getChatContext(MODEL)).quickModel).toEqual(CONFIG);
      await user.setPreferredModel(MODEL);
      expect(await user.getQuickModel()).toBe(MODEL);
      expect(await user.getPreferredModel()).toBe(MODEL);
      expect((await user.getExternalMessageChatContext(null)).aiModel?.profile).toEqual(PROFILE);
    });
    await inUser(
      OTHER,
      async (user) => {
        expect(await user.getQuickModel()).toBeNull();
        await expect(user.getChatContext(MODEL)).rejects.toThrow("disabled");
        expect((await user.getChatContext(null)).quickModel).toBeUndefined();
        expect(await user.getPreferredModel()).toBe(MODEL);
      },
      { modelModes: { [MODEL]: "disabled" } },
    );
  });
  it("rejects arbitrary quick selections without altering a valid choice", async () => {
    await inUser(OTHER, async (user) => {
      await user.setQuickModel(MODEL);
      await expect(user.setQuickModel("arbitrary")).rejects.toThrow("No such model");
      expect(await user.getQuickModel()).toBe(MODEL);
      await user.setQuickModel(null);
      expect(await user.getQuickModel()).toBeNull();
      expect((await user.getChatContext(null)).quickModel).toBeUndefined();
    });
  });
  it("atomically stores availability and rolls back failed mirrors", async () => {
    const fixture = settings();
    await fixture.inDo(async (admin) => {
      await admin.setSubscriptionModelEnabled(false);
      expect((await admin.getSettings(USER)).subscriptionModel).toEqual({
        id: MODEL,
        name: PROFILE.name,
        enabled: false,
      });
    });
    expect(JSON.parse(fixture.current()!).modelModes).toEqual({ [MODEL]: "disabled" });
    fixture.fail();
    await fixture.inDo(async (admin) => {
      await expect(admin.setSubscriptionModelEnabled(true)).rejects.toThrow("KV unavailable");
      expect(admin.getAdminConfig().modelModes).toEqual({ [MODEL]: "disabled" });
    });
  });
  it("removes only its own override and refuses legacy administration", async () => {
    const fixture = settings();
    await fixture.inDo(async (admin) => {
      await admin.updateAdminConfig({ modelModes: { [MODEL]: "disabled", preserved: "hidden" } });
      await admin.setSubscriptionModelEnabled(true);
      expect(admin.getAdminConfig().modelModes).toEqual({ preserved: "hidden" });
      expect((await admin.getSettings(USER)).subscriptionModel).toEqual({
        id: MODEL,
        name: PROFILE.name,
        enabled: true,
      });
    });
    await runInDurableObject(
      env.TEST_USER_DIRECTORY.getByName(`subscription-legacy-${++count}`),
      async (_u, state) => {
        await expect(
          new AdminSettings(state, env).setSubscriptionModelEnabled(true),
        ).rejects.toThrow("admin-managed");
      },
    );
  });
  it("revokes a previously minted model binding after disable", async () => {
    await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""), async (admin) => {
      const original = admin.env;
      admin.env = managed();
      try {
        await admin.updateAdminConfig({
          ...DEFAULT_ADMIN_CONFIG,
          modelModes: { [MODEL]: "disabled" },
        });
      } finally {
        admin.env = original;
      }
    });
    await runInDurableObject(
      env.TEST_USER_DIRECTORY.getByName(`subscription-binding-${++count}`),
      async (_u, state) => {
        Object.defineProperty(state, "props", {
          configurable: true,
          value: {
            displayName: PROFILE.name,
            config: CONFIG,
            initiator: { type: "user", id: USER, name: "One" },
          },
        });
        await expect(
          new LanguageModelGatekeeper(state, managed()).startSession(undefined!),
        ).rejects.toThrow("disabled");
      },
    );
  });
  it("changes availability through an authenticated admin RPC capability", async () => {
    const user = env.TEST_USER.getByName(USER);
    const token = await user.loginOrCreateViaGatekeeper(USER, true);
    await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""), async (admin) => {
      const original = admin.env;
      admin.env = managed();
      try {
        const ctx = createExecutionContext();
        const response = await server.fetch(
          new Request("https://fixture.invalid/api", { headers: { Upgrade: "websocket" } }),
          { ...managed(), ADMINS: [USER] },
          ctx,
        );
        const socket = response.webSocket!;
        socket.accept();
        using api = newWebSocketRpcSession<PublicApi>(socket);
        using authenticated = await api.authenticate(`${USER}:${token}`);
        using adminApi = (await authenticated.getAdminApi())!;
        await adminApi.setSubscriptionModelEnabled(false);
        expect(admin.getAdminConfig().modelModes).toEqual({ [MODEL]: "disabled" });
        expect((await adminApi.getSettings()).subscriptionModel).toEqual({
          id: MODEL,
          name: PROFILE.name,
          enabled: false,
        });
        await adminApi.setSubscriptionModelEnabled(true);
        expect(admin.getAdminConfig().modelModes).toEqual({});
        await waitOnExecutionContext(ctx);
      } finally {
        admin.env = original;
      }
    });
  });
  it("does not expose the admin capability to non-admin sessions", async () => {
    const user = env.TEST_USER.getByName("nonadmin@example.invalid");
    const token = await user.loginOrCreateViaGatekeeper("nonadmin@example.invalid", true);
    await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""), async (admin) => {
      const original = admin.env;
      admin.env = managed();
      try {
        const ctx = createExecutionContext();
        const response = await server.fetch(
          new Request("https://fixture.invalid/api", { headers: { Upgrade: "websocket" } }),
          { ...managed(), ADMINS: [USER] },
          ctx,
        );
        const socket = response.webSocket!;
        socket.accept();
        using api = newWebSocketRpcSession<PublicApi>(socket);
        using authenticated = await api.authenticate(`nonadmin@example.invalid:${token}`);
        expect(await authenticated.getAdminApi()).toBeNull();
        expect(await authenticated.getAiConfig()).toMatchObject({
          enabled: true,
          transport: "subscription",
          userModelsEnabled: false,
        });
        await waitOnExecutionContext(ctx);
      } finally {
        admin.env = original;
      }
    });
  });
});
