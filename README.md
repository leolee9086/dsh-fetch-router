# @leolee9086/dsh-fetch-router

按 `host + path` 路由 DSH 的出网 HTTP 请求：可注入/改写请求头、改写目标、本地应答；带一个 **DSH 原生右侧栏**监控面板。默认规则解决 OpenCode Zen 网关的 `400 MissingSessionID`（该网关要求 `x-opencode-session`，缺失即拒）。

## 安装

已对照 DSH **0.2.0-rc.2** 的运行时服务契约适配。桌面部署使用 `desktop` profile，不是 `web`。

现有 DSH 的插件管理器中安装 GitHub 地址：

```text
github:leolee9086/dsh-fetch-router#<commit-sha>
```

将 `<commit-sha>` 换成已发布提交，可固定安装版本。具有 DSH CLI 的部署也可使用：

```sh
dsh plugin --profile desktop add github:leolee9086/dsh-fetch-router#<commit-sha>
dsh plugin --profile desktop remove @leolee9086/dsh-fetch-router
```

以安装器报告的 `applied` 或 `restart-required` 为准；已有 Host 代码的更新需要重启才会替换 Node 模块。不要用本地 `link:` 安装代替 GitHub 发布验收。

包自带 bundle patch（`cordis.patch.yml`），安装后由 `dsh plugin` 并入 profile layers，不需要手改 profile 的 `cordis.patch.yml`。

依赖 [`@leolee9086/sac-path-router`](https://github.com/leolee9086/sac-path-router)（同为 npm 包，安装时不跑构建脚本）。

## 配置

默认配置在包内 `cordis.patch.yml`；在 profile 的 `cordis.patch.yml` 里用同 `id: fetch-router` 覆盖 `config` 即可改规则。

```yaml
    - id: fetch-router
      name: "@leolee9086/dsh-fetch-router"
      config:
        reserved: [user-agent]          # 永不被规则覆盖的请求头
        ifAbsent: true                  # 目标头已存在则不覆盖
        allowMock: false                # 允许 respond 本地应答（伪造响应不进会话日志）
        onMissing: fail                 # 规则 require 不满足时：fail | skip
        log: { matched: true, passthrough: false, headers: false, buffer: 200 }
        panel: { enabled: true, path: '/fetch-router' }
        routes:
          - id: opencode-session-chat
            match: { host: "opencode.ai", path: "/zen/go/v1/chat/completions", methods: [POST], provider: "opencode-go*" }
            require: [session]
            headers: { x-opencode-session: "$session" }
```

- `match`：`host`（必需，支持 `*.example.com`）、`path`（radix 通配，默认 `/**`）、`methods`、`provider`、`model`、`purpose`（后三者取自当前请求的模型调用作用域）。
- 模板：`$session`、`$provider`、`$model`、`$purpose`、`$requestId`；取不到值即报错（`onMissing: fail`）。
- `rewrite.url`：把请求改到另一个目标；`rewrite.path` / `rewrite.search` 可选。
- `respond`：本地应答，需 `allowMock: true`。伪造响应会进入模型上下文但不进会话日志，破坏 "Model-visible ⟺ logged"，仅测试 profile 使用。
- 同一 `path` 上多条规则按声明顺序取第一条满足条件的；未命中任何端点规则 ⇒ 不做端点处理，请求照常出网。

## 面板

界面半边注册一个原生右侧栏 tab（`sidebarRightTabs` + `sidebar.right.pane.tab`），入口按钮在左侧栏底部（`sidebar.footer.action`，无会话时置灰）。

- 逐请求行：时间 / `host+path` / 方法 / 命中规则 / 被改动的头名（值默认只以名字呈现）/ 结果（`forward`·`mock`·`skipped`·`error`）/ `provider·model` / 上游状态码 / 耗时。
- 顶部：命中、透传、本地应答、错误计数；当前生效路由表；暂停记录按钮。
- 数据面：`GET {panel.path}/stats.json`、`GET {panel.path}/events`（SSE）、`POST {panel.path}/recording`。仅接受 loopback 请求，并复用 DSH `connection.requestRejection()` 的 Host/Origin 与签名 Cookie 校验。缺少 Connection 服务时不挂载面板。
- 隐私：不写会话日志、不发 session 事件；默认不记录 body；`authorization`、`cookie`、`*token*`、`*secret*` 等永不显示值。

## 两层：内容改写与端点路由

router 里有两层，各管一件事，**不共用一道门**：

- **中间件层（内容改写）**：`requestRewrite` 登记的改写器，在**路径匹配之前**跑，
  对所有请求生效。它看的是 body，跟这条请求发去哪个 host 无关。改完写进 `ctx.requestBody`，
  由 fetch 入口在出网时使用。显式字符串 body 可改；SDK 传入的 `Request` 仅在媒体类型为 JSON（含 `+json`）或 `text/*` 时读取 clone 后改写。显式流、FormData、URLSearchParams 与二进制 `Request` 不碰。
- **路由层（端点规则）**：按 `host` + `path` 匹配，决定注头 / 改目标 / 本地应答。

分层的理由：内容改写是「某一次发送时对 body 的操作」，跟端点归属正交。
把两件事塞进同一个判断，会让**未命中端点规则的 host 连 body 都改不了** ——
而那正是内容改写唯一关心的事。

代价：所有请求都会构造 `Request`（不再有 host 早退）。换取的是改写对每条请求都成立。

## 行为与边界

- 所有请求都交给 router：中间件层要对每条请求跑一次改写，所以没有 host 早退。
  未命中端点规则的请求不带端点处理，原样出网。
- 改写器抛错时立即拒绝本次请求，原始异常及其 `cause` 向调用方传播；非法返回值直接报错，不跳过后继续发送。
- 改写记录与端点记录使用同一回调，均携带原始 `request`，记录动作不写模型消息或会话历史。
- 配置非法 ⇒ 拒绝安装，保持原 `fetch`。
- dispose 后先变为纯透传，再按身份还原 `globalThis.fetch`。
- 改写 `ctx.path` 的重派那趟不发网，body 只在最终转发时消费一次。
- 不覆盖：`node:http` 直连的 SDK；pi-ai `transport: 'websocket'` 路由。

## 开发

```sh
pnpm install
pnpm test
pnpm pack
```

完整测试使用 Node test runner；受限沙箱若拒绝派生测试子进程，需要允许同一测试命令。`prepack` 会先运行完整测试，包内 `lib` 已是可直接安装的产物，不需要安装时构建。

当前 npm 路由依赖 `0.1.1` 的已发布 fetch 入口缺少 `requestBody` 传递，插件用独立适配层补齐；不要求安装依赖仓库的未发布源码。

## 赞赏

![赞赏码](assets/sponsor-qr.png)

> **联系作者**：逐暝（leolee9086）· 点击链接加入群聊【工具软件爱好者折腾群-综合讨论】：https://qm.qq.com/q/RAHJuyhQQ （群号 1017854502，群主 逐暝）

## 许可

MIT

---

作者：逐暝 · QQ 群：1017854502 — https://qm.qq.com/q/RAHJuyhQQ
