import {
  DEFAULT_SETTINGS,
  DDL_ENDPOINT,
  errorMessage,
  parseSelection,
  parseSettings,
  permissionOrigin,
} from "./api.js";

const element = (id) => document.getElementById(id);
let windowId;
let state;
element("settings-form").addEventListener("submit", saveSettings);
element("query").addEventListener("click", submitQuery);
element("copy").addEventListener("click", copyResult);
element("selection").addEventListener("input", updateCount);
element("auth-mode").addEventListener("change", showAuthMode);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[`query:${windowId}`])
    renderResult(changes[`query:${windowId}`].newValue);
  if (area === "local" && changes.settings?.newValue)
    showDestination(changes.settings.newValue);
});
void initialize();

async function initialize() {
  try {
    windowId = (await chrome.windows.getCurrent()).id;
    const [{ settings }, session] = await Promise.all([
      chrome.storage.local.get("settings"),
      chrome.storage.session.get(["auth", `query:${windowId}`]),
    ]);
    const initial = settings ?? DEFAULT_SETTINGS;
    element("cid").value = initial.cid;
    element("database").value = initial.defaultDatabase;
    element("auth-mode").value = initial.authMode;
    element("configuration").open = !settings;
    if (settings) showDestination(settings);
    if (session.auth?.endpoint === DDL_ENDPOINT)
      element("token").value = session.auth.token;
    showAuthMode();
    renderResult(session[`query:${windowId}`]);
  } catch (error) {
    element("settings-status").textContent = errorMessage(error);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    const settings = parseSettings({
      cid: element("cid").value.trim(),
      defaultDatabase: element("database").value.trim(),
      authMode: element("auth-mode").value,
    });
    const token =
      settings.authMode === "bearer" ? element("token").value.trim() : "";
    if (settings.authMode === "bearer" && (!token || /[\r\n]/.test(token)))
      throw new Error("请填写有效的 Bearer Token。");
    // Chrome 需要直接在按钮事件中申请权限，不能先 await 存储操作。
    const granted = await chrome.permissions.request({
      origins: [permissionOrigin()],
    });
    if (!granted) throw new Error("未获得接口域名的访问权限，配置尚未保存。");
    await chrome.storage.session.set({
      auth: { endpoint: DDL_ENDPOINT, token },
    });
    await chrome.storage.local.set({ settings });
    showDestination(settings);
    element("configuration").open = false;
    element("settings-status").textContent = "配置已保存，可以查询 DDL 了。";
  } catch (error) {
    element("settings-status").textContent = errorMessage(error);
  }
}

async function submitQuery() {
  try {
    const text = parseSelection(element("selection").value);
    element("result-status").textContent = "正在查询…";
    await chrome.runtime.sendMessage({ type: "query", text, windowId });
  } catch (error) {
    element("result-status").textContent = errorMessage(error);
  }
}

async function copyResult() {
  try {
    await navigator.clipboard.writeText(state.result);
    element("result-status").textContent = "DDL 已复制。";
  } catch {
    element("result-status").textContent = "复制失败，请手动选择 DDL 并复制。";
  }
}

function renderResult(nextState) {
  const changedSelection = state?.id !== nextState?.id;
  state = nextState;
  if (!state) return;
  if (changedSelection) element("selection").value = state.text;
  updateCount();
  const success = state.status === "success";
  element("empty-state").hidden = true;
  element("columns-table").hidden = !success;
  element("ddl-response").hidden = !success;
  element("result").textContent = state.result;
  element("raw-response").hidden = !success;
  element("raw-json").textContent = state.rawJson ?? "";
  renderColumns(success ? state.columns : []);
  if (changedSelection) {
    element("ddl-response").open = false;
    element("raw-response").open = false;
  }
  element("table-identity").hidden = !success;
  element("table-identity").textContent = success
    ? `${state.qualifiedName} · 集群 ${state.cid}`
    : "";
  element("result-error").hidden = state.status !== "error";
  element("result-error").textContent = state.error;
  element("copy").disabled = !success;
  element("result-status").textContent =
    state.status === "loading"
      ? "正在查询… 如长时间没有响应，可以再次点击查询。"
      : success
        ? `HTTP ${state.httpStatus} · ${(state.elapsedMs / 1000).toFixed(1)} 秒`
        : "查询未完成";
}

function renderColumns(columns) {
  const body = element("columns-body");
  body.replaceChildren();
  for (const column of columns ?? []) {
    const row = document.createElement("tr");
    for (const value of [column.name, column.type, column.comment]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
}

function updateCount() {
  element("selection-count").textContent =
    `${element("selection").value.length} 字符`;
}
function showDestination(settings) {
  element("config-label").textContent = `集群 ${settings.cid}`;
  element("destination").textContent =
    `默认库 ${settings.defaultDatabase} · 集群 ${settings.cid}`;
}
function showAuthMode() {
  const mode = element("auth-mode").value;
  element("token-field").hidden = mode !== "bearer";
  element("auth-hint").textContent =
    mode === "cookie"
      ? "请求会携带当前 Chrome 对数据平台的登录 Cookie。请先在同一个浏览器中登录；扩展不会读取或保存 Cookie。"
      : mode === "bearer"
        ? "Token 仅保留在本次浏览器会话，重启浏览器或重载扩展后需重填。"
        : "只向指定接口发送集群 ID、库名和表名，不携带 Cookie 或 Token。";
}
