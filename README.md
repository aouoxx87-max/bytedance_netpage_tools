# 飞书 Hive DDL 查询

独立 Chrome Manifest V3 扩展：在飞书文档中选中 `库名.表名`，右键选择 **查询 Hive 建表语句**，右侧面板展示并复制 DDL。无需启动 Auto-Ontology，也不依赖任何构建工具或运行时依赖。

## 安装与首次配置

1. 使用 Chrome 116 或以上版本，打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的本项目目录。
3. 点击扩展图标打开侧栏，在「查询设置」中确认集群 ID（默认 `50`）和默认库名（默认 `ecom`）。
4. 选择接口实际使用的鉴权方式，再点击「保存并授权接口」，允许访问 `https://data.bytedance.net/*`。
5. 在飞书文档中选中 `ecom.app_ranklist_product_stats_df`，右键选择「查询 Hive 建表语句」。也可在侧栏粘贴表名后点击「查询 DDL」。

本扩展需要由你在 Chrome 的扩展管理页面加载。普通网页预览无法调用扩展 API，也不能代替真实扩展验收。

## 接口与表名规则

固定使用你提供的 Hive DDL 接口，HTTP 方法为 GET：

```text
https://data.bytedance.net/new_coralng_rcp_api/v2/bridge/hive/ddl
  ?cid=50
  &dbName=ecom
  &tableName=app_ranklist_product_stats_df
```

| 选中内容                                     | 解析结果                 |
| -------------------------------------------- | ------------------------ |
| `ecom.app_ranklist_product_stats_df`         | 指定库名和表名           |
| `` `ecom`.`app_ranklist_product_stats_df` `` | 去掉 SQL 标识符的反引号  |
| `` `ecom.app_ranklist_product_stats_df` ``   | 去掉整段行内代码的反引号 |
| `app_ranklist_product_stats_df`              | 使用设置中的默认库名     |

支持字母、数字、下划线及分隔符两侧空格。多张表、整句 SQL、三段式名称和无法明确解析的文本会提示重新选择，不会猜测表名并发请求。

接口响应必须有数字类型的 `code`：`code=0` 时提取非空的 `data.ddl`，保留其换行、字段注释和分区定义；非零时显示业务错误。返回中如果包含集群、库名或表名，必须与请求匹配。侧栏提供「复制 DDL」和「查看原始 JSON」。返回文本不会作为 HTML 或脚本执行。

## 鉴权

首次默认不携带身份信息，需在设置中选择接口实际要求的模式。

- **使用当前 Chrome 的网页登录态**：先在同一 Chrome 用户配置中登录 `https://data.bytedance.net/`，再查询。扩展以 `credentials: include` 请求固定数据平台域名，浏览器负责附带匹配的 Cookie；扩展不读取、复制或保存 Cookie，不申请 `cookies` 权限。
- **Bearer Token**：在设置中填写 Token，通过 `Authorization` 请求头发送。Token 只存于浏览器会话，重启浏览器或重载扩展后需重新填写。
- **不使用鉴权**：不携带 Cookie 或 Authorization。

登录过期、无表权限、公司网络不可达或企业浏览器策略均可能使查询失败。401/403、HTML 登录页、业务错误和超时都会显示提示。请求不跟随重定向；需要 SSO 登录时请先打开数据平台完成登录，而不是在扩展中自动跳转。实际网页登录态是否可用仍需在你的 Chrome 环境中联调。

## 数据与权限

接口仅接收 `cid`、`dbName`、`tableName`，以及所选鉴权方式附带的身份信息；不发送飞书文档全文、标题或 URL。无需飞书 OpenAPI 授权。

右键入口匹配 `https://*.feishu.cn/*` 和 `https://*.larksuite.com/*`。自定义企业文档域名可添加到 `src/background.js` 中的 `documentPatterns`。如文档画布未暴露浏览器原生文本选区，可将表名复制到侧栏查询。

配置保存在当前浏览器本地，选文、结果和 Token 只在当前会话保留。每个窗口独立保存最近的查询；连续查询会取消前一次请求，晚返回的旧结果不会覆盖新结果。请求超时为 20 秒，选文上限 512 字符，响应上限 1 MB。

## 开发和测试

需要 Node.js 22 或以上版本，无需安装 npm 依赖：

```bash
npm test
```

测试覆盖表名拆分、接口参数、Cookie/Bearer 模式、响应与 DDL 保真、业务错误、错误表名、超时、取消和多窗口竞争。HTTP 测试仅访问本机临时服务器，不会请求企业接口。

```text
manifest.json       权限、后台进程和侧栏入口
panel.html / .css    中文侧栏
src/api.js          表名与配置校验、GET 参数和 DDL 响应解析
src/background.js   右键入口、请求调度及按窗口保留结果
src/panel.js        授权、设置与结果展示
tests/              HTTP 集成与 Chrome API 模拟测试
```

首次真实验收：授权接口 → 登录数据平台（若使用网页登录态）→ 选中表名 → 查询 → 核对 DDL → 复制到文本编辑器，确认换行保留。再测试一个不存在或无权限的表，确认显示错误而不是空白结果。

实现参考：[Chrome Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)、[可选域名授权](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[扩展 Cookie 行为](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)。
