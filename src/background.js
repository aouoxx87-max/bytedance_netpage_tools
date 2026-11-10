import {
  DDL_ENDPOINT,
  errorMessage,
  parseSelection,
  parseTableSelection,
  parseSettings,
  permissionOrigin,
  queryApi,
} from "./api.js";

const MENU_ID = "query-feishu-selection";
const active = new Map();
const documentPatterns = ["https://*.feishu.cn/*", "https://*.larksuite.com/*"];

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "查询 Hive 建表语句",
      contexts: ["selection"],
      documentUrlPatterns: documentPatterns,
    });
  });
  await chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);
  if (details.reason !== "install") return;
  // 部分 Chrome 渠道允许安装事件直接打开侧栏；强制手势的渠道会拒绝，由点击工具栏图标兜底。
  const window = await chrome.windows.getCurrent().catch(console.error);
  if (window) await chrome.sidePanel.open({ windowId: window.id }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  // 必须在右键事件内直接打开，异步读取配置后会丢失用户手势。
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  void runQuery(info.selectionText, tab.windowId);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("panel.html")
  )
    return;
  if (message?.type !== "query" || !Number.isInteger(message.windowId)) return;
  void runQuery(message.text, message.windowId).then(() =>
    respond({ ok: true }),
  );
  return true;
});

chrome.windows.onRemoved.addListener((windowId) => {
  active.get(windowId)?.controller.abort();
  active.delete(windowId);
  void chrome.storage.session.remove(`query:${windowId}`);
});

async function runQuery(rawText, windowId) {
  const operation = {
    id: crypto.randomUUID(),
    controller: new AbortController(),
  };
  active.get(windowId)?.controller.abort();
  active.set(windowId, operation);
  const state = {
    id: operation.id,
    text: "",
    status: "loading",
    result: "",
    error: "",
    startedAt: Date.now(),
  };
  try {
    state.text = parseSelection(rawText);
    await publish(windowId, operation, state);
    const { settings: rawSettings } =
      await chrome.storage.local.get("settings");
    if (!rawSettings)
      throw new Error("首次使用请在侧栏保存查询设置，并授权访问数据平台。");
    const settings = parseSettings(rawSettings);
    const table = parseTableSelection(state.text, settings.defaultDatabase);
    if (
      !(await chrome.permissions.contains({
        origins: [permissionOrigin()],
      }))
    ) {
      throw new Error(
        "尚未授权此接口域名，请在侧边栏重新保存接口配置并允许访问。",
      );
    }
    const { auth } = await chrome.storage.session.get("auth");
    const token = auth?.endpoint === DDL_ENDPOINT ? auth.token : "";
    const response = await queryApi(settings, table, token, {
      signal: operation.controller.signal,
    });
    await publish(windowId, operation, {
      ...state,
      ...response,
      status: "success",
      elapsedMs: Date.now() - state.startedAt,
    });
  } catch (error) {
    await publish(windowId, operation, {
      ...state,
      status: "error",
      error: errorMessage(error),
    });
  } finally {
    if (active.get(windowId) === operation) active.delete(windowId);
  }
}

async function publish(windowId, operation, state) {
  if (active.get(windowId) === operation) {
    await chrome.storage.session.set({ [`query:${windowId}`]: state });
  }
}
