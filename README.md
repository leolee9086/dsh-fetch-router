# dsh-fetch-router

按 `host + path` 路由 DSH 的出网 HTTP 请求：可注入/改写请求头、改写目标、本地应答；带一个 **DSH 原生右侧栏**监控面板。默认规则解决 OpenCode Zen 网关的 `400 MissingSessionID`（该网关要求 `x-opencode-session`，缺失即拒）。

## 安装

```sh
dsh plugin --profile web add git+https://github.com/leolee9086/dsh-fetch-router.git
dsh plugin --profile web remove dsh-fetch-router
```

装完重启 DSH 让宿主半边生效；界面半边改动硬刷新浏览器即可。

包自带 bundle patch（`cordis.patch.yml`），安装后由 `dsh plugin` 并入 profile layers，不需要手改 profile 的 `cordis.patch.yml`。

依赖 [`sac-path-router`](https://github.com/leolee9086/sac-path-router)，同样按 git 依赖拉取（两个仓库都把运行所需的构建产物入库，因此安装时不跑任何构建脚本）。要锁版本可加提交号：`git+https://github.com/leolee9086/dsh-fetch-router.git#<commit>`。

## 配置

默认配置在包内 `cordis.patch.yml`；在 profile 的 `cordis.patch.yml` 里用同 `id: fetch-router` 覆盖 `config` 即可改规则。

```yaml
    - id: fetch-router
      name: "dsh-fetch-router"
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
- 同一 `path` 上多条规则按声明顺序取第一条满足条件的；未命中任何规则 ⇒ 原样透传（不构造 `Request`）。

## 面板

界面半边注册一个原生右侧栏 tab（`sidebarRightTabs` + `sidebar.right.pane.tab`），入口按钮在左侧栏底部（`sidebar.footer.action`，无会话时置灰）。

- 逐请求行：时间 / `host+path` / 方法 / 命中规则 / 被改动的头名（值默认只以名字呈现）/ 结果（`forward`·`mock`·`skipped`·`error`）/ `provider·model` / 上游状态码 / 耗时。
- 顶部：命中、透传、本地应答、错误计数；当前生效路由表；暂停记录按钮。
- 数据面：`GET {panel.path}/stats.json`、`GET {panel.path}/events`（SSE）、`POST {panel.path}/recording`。仅接受 loopback 请求。
- 隐私：不写会话日志、不发 session 事件；默认不记录 body；`authorization`、`cookie`、`*token*`、`*secret*` 等永不显示值。

## 行为与边界

- 未命中直接调用原 `fetch`，不构造对象、不读 body。
- 配置非法 ⇒ 拒绝安装，保持原 `fetch`。
- dispose 后先变为纯透传，再按身份还原 `globalThis.fetch`。
- 改写 `ctx.path` 的重派那趟不发网，body 只在最终转发时消费一次。
- 不覆盖：`node:http` 直连的 SDK；pi-ai `transport: 'websocket'` 路由。

## 开发

```sh
pnpm install
node test/rules.test.js && node test/interceptor.test.js && node test/scope.test.js
```

（`node --test` 会派生子进程，在受限沙箱里会被拒；逐文件执行等价。）

## 许可

MIT
