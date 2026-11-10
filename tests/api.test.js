import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  buildRequest,
  DEFAULT_SETTINGS,
  DDL_ENDPOINT,
  MAX_RESPONSE_BYTES,
  parseDdlResponse,
  parseSelection,
  parseSettings,
  parseTableSelection,
  permissionOrigin,
  queryApi,
} from "../src/api.js";

const ddl =
  "CREATE TABLE `ecom`.`orders`(\n  `prod_id` BIGINT COMMENT '商品id',\n  `amount` DECIMAL(38,6) COMMENT '成交金额')\nPARTITIONED BY (`date` STRING COMMENT '业务日期')\n";
const table = { dbName: "ecom", tableName: "orders" };
const settings = parseSettings(DEFAULT_SETTINGS);
const success = {
  errorCode: "01-200-C00000",
  code: 0,
  version: "v2",
  message: "success",
  data: { cid: 50, parentName: "ecom", name: "orders", ddl },
};
let server;
let origin;
let received;
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    received = {
      url,
      method: req.method,
      authorization: req.headers.authorization,
    };
    const name = url.searchParams.get("tableName");
    if (name === "unauthorized") {
      res.writeHead(401);
      res.end("private error");
      return;
    }
    if (name === "redirect") {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    if (name === "slow") {
      setTimeout(() => res.end(JSON.stringify(success)), 80);
      return;
    }
    if (name === "html") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><html>Login</html>");
      return;
    }
    if (name === "large") {
      res.writeHead(200, { "Transfer-Encoding": "chunked" });
      res.end("x".repeat(MAX_RESPONSE_BYTES + 1));
      return;
    }
    if (name === "invalid") {
      res.end("broken JSON");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(success));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

// 所有集成请求仅发到本机测试服务器，不访问企业接口。
const localFetch = (url, options) =>
  fetch(origin + new URL(url).pathname + new URL(url).search, options);
const query = (name, options = {}) =>
  queryApi(settings, { ...table, tableName: name }, "", {
    fetchImpl: localFetch,
    ...options,
  });

for (const selection of [
  "ecom.orders",
  "`ecom`.`orders`",
  "`ecom.orders`",
  "ecom . orders",
  "  ecom.orders\n",
]) {
  test(`parses qualified table: ${selection}`, () =>
    assert.deepEqual(
      parseTableSelection(parseSelection(selection), "fallback"),
      table,
    ));
}
test("unqualified table uses the configured default database", () => {
  assert.deepEqual(parseTableSelection("orders", "ecom"), table);
  assert.deepEqual(parseTableSelection("`orders`", "other"), {
    dbName: "other",
    tableName: "orders",
  });
});
test("refuses ambiguous text, SQL, multiple tables and malformed quoting", () => {
  for (const value of [
    "a.b.c",
    "select * from ecom.orders",
    "a.b, c.d",
    "a.b\nc.d",
    "a/b",
    "a.b;DROP TABLE x",
    "`a.b",
    "a..b",
    "中文表",
    "a b",
  ]) {
    assert.throws(() => parseTableSelection(value, "ecom"), /请只选择/);
  }
  for (const value of [null, {}, " ", "a".repeat(513)])
    assert.throws(() => parseSelection(value));
});
test("validates configuration at entry", () => {
  for (const cid of ["-1", "1.2", "abc", "9007199254740993", 50, ""])
    assert.throws(() => parseSettings({ ...DEFAULT_SETTINGS, cid }));
  assert.doesNotThrow(() =>
    parseSettings({ ...DEFAULT_SETTINGS, cid: "0" }),
  );
  assert.throws(() =>
    parseSettings({ ...DEFAULT_SETTINGS, defaultDatabase: "db.name" }),
  );
  assert.throws(() =>
    parseSettings({ ...DEFAULT_SETTINGS, authMode: "custom" }),
  );
  assert.throws(() => parseSettings(undefined));
});
test("builds the supplied API contract with GET and exactly three query parameters", () => {
  const request = buildRequest(
    settings,
    { dbName: "ecom", tableName: "app_ranklist_product_stats_df" },
    "",
  );
  assert.equal(
    request.url,
    `${DDL_ENDPOINT}?cid=50&dbName=ecom&tableName=app_ranklist_product_stats_df`,
  );
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.body, undefined);
  assert.equal(request.options.redirect, "error");
  assert.equal(permissionOrigin(), "https://data.bytedance.net/*");
});
test("default mode includes browser credentials without reading or serializing cookies", () => {
  const request = buildRequest(settings, table, "unused-token");
  assert.equal(request.options.credentials, "include");
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.headers.Cookie, undefined);
});
test("Bearer and no-auth modes omit browser credentials", () => {
  const bearer = { ...settings, authMode: "bearer" };
  const request = buildRequest(bearer, table, "test-token");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.equal(request.options.credentials, "omit");
  assert.throws(() => buildRequest(bearer, table, ""), /Token/);
  assert.throws(() => buildRequest(bearer, table, "a\nb"), /Token/);
  const unauthenticated = buildRequest(
    { ...settings, authMode: "none" },
    table,
    "stale-token",
  );
  assert.equal(unauthenticated.options.headers.Authorization, undefined);
  assert.equal(unauthenticated.options.credentials, "omit");
});
test("extracts DDL preserving newlines, Unicode, decimal types and partition clauses", async () => {
  const result = await query("orders");
  assert.equal(result.result, ddl);
  assert.equal(result.qualifiedName, "ecom.orders");
  assert.equal(result.cid, "50");
  assert.deepEqual(JSON.parse(result.rawJson), success);
  assert.equal(received.method, "GET");
  assert.deepEqual(Object.fromEntries(received.url.searchParams), {
    cid: "50",
    dbName: "ecom",
    tableName: "orders",
  });
});
test("reports business failures even when HTTP succeeds", () => {
  assert.throws(
    () =>
      parseDdlResponse(
        { code: 403, message: "无权限", data: null },
        settings,
        table,
      ),
    /无权限/,
  );
});
test("rejects incomplete or invalid success payloads", () => {
  for (const payload of [
    null,
    [],
    {},
    { code: "0" },
    { code: 0 },
    { code: 0, data: { ddl: "" } },
    { code: 0, data: { ddl: {} } },
  ]) {
    assert.throws(() => parseDdlResponse(payload, settings, table));
  }
});
test("refuses a different cluster, database or table in the response", () => {
  for (const change of [
    { cid: 51 },
    { parentName: "other" },
    { name: "other" },
  ]) {
    assert.throws(
      () =>
        parseDdlResponse(
          { ...success, data: { ...success.data, ...change } },
          settings,
          table,
        ),
      /不一致/,
    );
  }
});
test("HTTP authentication errors and HTML login pages give a login hint", async () => {
  await assert.rejects(query("unauthorized"), /HTTP 401.*登录/);
  await assert.rejects(query("html"), /登录已过期/);
});
test("does not follow authentication redirects", async () => {
  await assert.rejects(query("redirect"));
});
test("times out and supports cancellation", async () => {
  await assert.rejects(query("slow", { timeoutMs: 10 }), {
    name: "TimeoutError",
  });
  await assert.rejects(query("orders", { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
});
test("reports malformed JSON and enforces streaming response size", async () => {
  await assert.rejects(query("invalid"), SyntaxError);
  await assert.rejects(query("large"), /1 MB/);
});
test("sends only the explicit Bearer token", async () => {
  await queryApi({ ...settings, authMode: "bearer" }, table, "test-token", {
    fetchImpl: localFetch,
  });
  assert.equal(received.authorization, "Bearer test-token");
});
