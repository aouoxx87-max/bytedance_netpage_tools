export const DDL_ENDPOINT =
  "https://data.bytedance.net/new_coralng_rcp_api/v2/bridge/hive/ddl";
export const DEFAULT_SETTINGS = {
  cid: "50",
  defaultDatabase: "ecom",
  authMode: "cookie",
};
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const identifier = "(?:`[A-Za-z0-9_]+`|[A-Za-z0-9_]+)";
const tablePattern = new RegExp(
  `^(${identifier})(?:\\s*\\.\\s*(${identifier}))?$`,
);

export function parseSettings(input) {
  if (
    !input ||
    typeof input.cid !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(input.cid) ||
    !Number.isSafeInteger(Number(input.cid))
  ) {
    throw new Error("集群 ID 必须是非负整数。");
  }
  if (
    typeof input.defaultDatabase !== "string" ||
    !/^[A-Za-z0-9_]+$/.test(input.defaultDatabase)
  ) {
    throw new Error("默认库名只能包含英文字母、数字和下划线。");
  }
  if (!["cookie", "bearer", "none"].includes(input.authMode))
    throw new Error("请选择有效的鉴权方式。");
  return {
    cid: input.cid,
    defaultDatabase: input.defaultDatabase,
    authMode: input.authMode,
  };
}

export function parseSelection(text) {
  if (typeof text !== "string" || !text.trim())
    throw new Error(
      "请选中一个表名，例如 ecom.app_ranklist_product_stats_df。",
    );
  if (text.length > 512)
    throw new Error("选中内容太长，请只选择一个库名.表名。");
  return text.trim();
}

export function parseTableSelection(text, defaultDatabase) {
  // 飞书行内代码复制出来可能是 `db.table`，也可能是 SQL 的 `db`.`table`。
  const inlineCode = /^`([A-Za-z0-9_]+\s*\.\s*[A-Za-z0-9_]+)`$/.exec(text);
  const match = tablePattern.exec(inlineCode ? inlineCode[1] : text);
  if (!match)
    throw new Error(
      "请只选择一个表名：库名.表名 或 表名。支持反引号，不支持整句 SQL、多张表或三段式名称。",
    );
  const first = match[1].replaceAll("`", "");
  return match[2]
    ? { dbName: first, tableName: match[2].replaceAll("`", "") }
    : { dbName: defaultDatabase, tableName: first };
}

export function permissionOrigin() {
  return "https://data.bytedance.net/*";
}

export function buildRequest(settings, table, token) {
  const url = new URL(DDL_ENDPOINT);
  url.searchParams.set("cid", settings.cid);
  url.searchParams.set("dbName", table.dbName);
  url.searchParams.set("tableName", table.tableName);
  const options = {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: settings.authMode === "cookie" ? "include" : "omit",
    redirect: "error",
    cache: "no-store",
  };
  if (settings.authMode === "bearer") {
    if (!token || /[\r\n]/.test(token))
      throw new Error("请在设置中填写有效的 Bearer Token。");
    options.headers.Authorization = `Bearer ${token}`;
  }
  return { url: url.href, options };
}

export async function queryApi(
  settings,
  table,
  token,
  { signal, timeoutMs = 20000, fetchImpl = fetch } = {},
) {
  const request = buildRequest(settings, table, token);
  const timeout = AbortSignal.timeout(timeoutMs);
  request.options.signal = signal
    ? AbortSignal.any([signal, timeout])
    : timeout;
  const response = await fetchImpl(request.url, request.options);
  if (!response.ok) {
    await response.body?.cancel();
    const hint = [401, 403].includes(response.status)
      ? "请在当前 Chrome 中登录 data.bytedance.net，并确认账号有该表的访问权限。"
      : "请检查网络、集群 ID 和表名。";
    throw new Error(`接口返回 HTTP ${response.status}。${hint}`);
  }
  const body = await readLimitedBody(response);
  if (/^\s*</.test(body))
    throw new Error(
      "接口返回了 HTML 页面，可能登录已过期。请先在当前 Chrome 中登录数据平台，再重试。",
    );
  return {
    ...parseDdlResponse(JSON.parse(body), settings, table),
    httpStatus: response.status,
  };
}

export function parseDdlResponse(payload, settings, table) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.code !== "number"
  )
    throw new Error("接口响应格式不符合预期：缺少数字类型的 code。");
  if (payload.code !== 0) {
    const message =
      typeof payload.message === "string"
        ? payload.message.slice(0, 500)
        : "查询失败";
    throw new Error(`查询失败（code=${payload.code}）：${message}`);
  }
  if (
    !payload.data ||
    typeof payload.data.ddl !== "string" ||
    !payload.data.ddl.trim()
  )
    throw new Error("接口返回成功，但 data.ddl 为空或缺失。");
  if (
    (payload.data.cid !== undefined &&
      String(payload.data.cid) !== settings.cid) ||
    (payload.data.parentName !== undefined &&
      payload.data.parentName !== table.dbName) ||
    (payload.data.name !== undefined && payload.data.name !== table.tableName)
  ) {
    throw new Error(
      "接口返回的集群或表名与本次请求不一致，未展示该 DDL。请核对集群和表名后重试。",
    );
  }
  return {
    result: payload.data.ddl,
    rawJson: JSON.stringify(payload, null, 2),
    qualifiedName: `${table.dbName}.${table.tableName}`,
    cid: settings.cid,
  };
}

async function readLimitedBody(response) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("接口响应超过 1 MB，请缩小返回内容。");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("接口响应超过 1 MB，请缩小返回内容。");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function errorMessage(error) {
  if (error.name === "TimeoutError") return "请求超过 20 秒，请稍后重试。";
  if (error.name === "AbortError") return "请求已取消。";
  if (error instanceof TypeError)
    return "请求失败。请检查公司网络、接口授权和 HTTPS 证书；若登录已过期，请先登录数据平台再重试。";
  if (error instanceof SyntaxError)
    return "接口未返回有效 JSON。请检查登录状态及接口响应。";
  return error.message || "请求失败，请稍后重试。";
}
