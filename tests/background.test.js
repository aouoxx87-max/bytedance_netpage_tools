import test from "node:test";
import assert from "node:assert/strict";
import { DDL_ENDPOINT } from "../src/api.js";
const response = (result) =>
  new Response(JSON.stringify({ code: 0, data: { ddl: result } }));

async function setup(
  fetchImpl,
  { allowed = true, authEndpoint = DDL_ENDPOINT } = {},
) {
  const listeners = {};
  const session = {
    auth: { endpoint: authEndpoint, token: "only-this-endpoint" },
  };
  const events = [];
  const panel = { installOpenCount: 0, behavior: null };
  globalThis.fetch = fetchImpl;
  globalThis.chrome = {
    runtime: {
      id: "test-extension",
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      onInstalled: {
        addListener: (fn) => {
          listeners.install = fn;
        },
      },
      onMessage: {
        addListener: (fn) => {
          listeners.message = fn;
        },
      },
    },
    contextMenus: {
      removeAll: (callback) => callback(),
      create: () => {},
      onClicked: {
        addListener: (fn) => {
          listeners.click = fn;
        },
      },
    },
    sidePanel: {
      open: async () => {
        events.push("open");
        panel.installOpenCount++;
      },
      setPanelBehavior: async (behavior) => {
        panel.behavior = behavior;
      },
    },
    action: {},
    permissions: { contains: async () => allowed },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      onRemoved: {
        addListener: (fn) => {
          listeners.close = fn;
        },
      },
    },
    storage: {
      local: {
        get: async () => {
          events.push("settings");
          return {
            settings: {
              cid: "50",
              defaultDatabase: "ecom",
              authMode: "bearer",
            },
          };
        },
      },
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (value) => Object.assign(session, structuredClone(value)),
        remove: async (key) => {
          delete session[key];
        },
      },
    },
  };
  await import(`../src/background.js?test=${crypto.randomUUID()}`);
  return { listeners, session, events, panel };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("test state timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("opens side panel before async work and sends selection with endpoint-bound token", async () => {
  let request;
  const mock = await setup(async (url, options) => {
    request = { url, options };
    return response("CREATE TABLE orders(id BIGINT)");
  });
  mock.listeners.click(
    { menuItemId: "query-feishu-selection", selectionText: "ecom.orders" },
    { windowId: 1 },
  );
  await waitUntil(() => mock.session["query:1"]?.status === "success");
  assert.equal(mock.events[0], "open");
  assert.equal(new URL(request.url).searchParams.get("tableName"), "orders");
  assert.equal(
    request.options.headers.Authorization,
    "Bearer only-this-endpoint",
  );
});

test("permission denial prevents any network request", async () => {
  let calls = 0;
  const mock = await setup(
    async () => {
      calls++;
      return new Response("bad");
    },
    { allowed: false },
  );
  mock.listeners.click(
    { menuItemId: "query-feishu-selection", selectionText: "private" },
    { windowId: 2 },
  );
  await waitUntil(() => mock.session["query:2"]?.status === "error");
  assert.equal(calls, 0);
  assert.match(mock.session["query:2"].error, /授权/);
});

test("tokens for a different endpoint cannot authorize a query", async () => {
  let calls = 0;
  const mock = await setup(
    async () => {
      calls++;
      return response("ddl");
    },
    { authEndpoint: "https://old.example.com/query" },
  );
  mock.listeners.click(
    { menuItemId: "query-feishu-selection", selectionText: "orders" },
    { windowId: 1 },
  );
  await waitUntil(() => mock.session["query:1"]?.status === "error");
  assert.equal(calls, 0);
  assert.match(mock.session["query:1"].error, /Token/);
});

test("late results cannot overwrite a newer selection; separate windows keep separate results", async () => {
  const pending = [];
  const mock = await setup(
    (url, options) =>
      new Promise((resolve) =>
        pending.push({
          text: new URL(url).searchParams.get("tableName"),
          resolve,
          signal: options.signal,
        }),
      ),
  );
  const click = (text, windowId) =>
    mock.listeners.click(
      { menuItemId: "query-feishu-selection", selectionText: text },
      { windowId },
    );
  click("first", 1);
  await waitUntil(() => pending.length === 1);
  click("second", 1);
  click("other_window", 2);
  await waitUntil(() => pending.length === 3);
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(response("second result"));
  pending[2].resolve(response("other result"));
  await waitUntil(
    () =>
      mock.session["query:1"].status === "success" &&
      mock.session["query:2"].status === "success",
  );
  pending[0].resolve(response("stale result"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(mock.session["query:1"].result, "second result");
  assert.equal(mock.session["query:2"].result, "other result");
});

test("only extension panel messages can trigger a query", async () => {
  let calls = 0;
  const mock = await setup(async () => {
    calls++;
    return response("CREATE TABLE orders(id BIGINT)");
  });
  const message = { type: "query", text: "private", windowId: 1 };
  assert.equal(
    mock.listeners.message(
      message,
      { id: "test-extension", url: "https://tenant.feishu.cn/docx/test" },
      () => {},
    ),
    undefined,
  );
  assert.equal(calls, 0);
  const reply = await new Promise((resolve) =>
    mock.listeners.message(
      message,
      {
        id: "test-extension",
        url: "chrome-extension://test-extension/panel.html",
      },
      resolve,
    ),
  );
  assert.deepEqual(reply, { ok: true });
  assert.equal(calls, 1);
});

test("first install enables action-click behavior and tries to open the right-side panel", async () => {
  const mock = await setup(async () => response("CREATE TABLE orders(id BIGINT)"));
  await mock.listeners.install({ reason: "install" });
  assert.deepEqual(mock.panel.behavior, { openPanelOnActionClick: true });
  assert.equal(mock.panel.installOpenCount, 1);
});

test("updating the extension does not pop the panel open", async () => {
  const mock = await setup(async () => response("CREATE TABLE orders(id BIGINT)"));
  await mock.listeners.install({ reason: "update" });
  assert.deepEqual(mock.panel.behavior, { openPanelOnActionClick: true });
  assert.equal(mock.panel.installOpenCount, 0);
});
