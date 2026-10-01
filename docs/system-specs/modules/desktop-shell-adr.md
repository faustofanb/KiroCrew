# ADR：桌面壳选型 —— Electron（保留）vs Tauri（迁移）

> **状态**：已决策（2026-10-01，fork 维护者）——**阶段一保留 Electron，设置明确的迁移触发条件**。
> 关联：[praxisd-acp.md](praxisd-acp.md)（后端替换路线）；PraxisCode 仓库 ER-ENG-006
> （PraxisCode 自有产品的 Tauri 基线，本决策不改变其效力，见 §5）。

## 1. 背景

KiroCrew fork 的目标是承载 PraxisCode 的产品壳，后端逐步替换为 praxisd。桌面层现有
两条路：

| | Electron 43（现状） | Tauri 2.11（PraxisCode 基线） |
|---|---|---|
| 运行时 | Chromium + Node 主进程，~150-200MB 基线内存 | 系统 WebView（macOS WKWebView），~30-60MB |
| 主进程语言 | JS（`website/electron/`，60+ 模块） | Rust |
| 现有集成 | 自动更新、badge、原生菜单、BrowserView/computer-use、托盘、通知、深链接、multiwindow | 需逐项重写 |

`website/electron/` 的存量主进程能力（实测清点）：`auto-update.js`、`badge.js`、
`app-menu.js`、`browser-view.js` / `browser-control.js` / `browser-agent-channel.js`
（内嵌浏览器 + agent 驱动）、`blocking-prompt.js`（原生权限对话）、窗口生命周期
latch、上下文菜单、协议注册等——**这不是薄壳，是半个产品**。

## 2. 决策

**阶段一（现在 → praxisd 真实后端成熟）：保留 Electron。**

理由：
1. **替换成本与收益错位**。当前主线是后端置换（ACP harness → praxisd），壳迁移会
   并行引入第二场大迁移，两线同时动 = 两边都不可验收。
2. **WebView 差异是回归面**。前端 2500+ 测试跑在 Chromium 语义上；WKWebView 的
   滚动/输入法/剪贴板行为差异会制造一批只在桌面端出现的缺陷——在 React 19 升级
   刚落地的当口再叠加一层回归源，不可控。
3. **内存收益当前不是瓶颈**。常驻型产品（KiroCrew 定位）在乎的是 gateway + agent
   子进程的总占用，Electron 壳在其中占比有限。

**迁移触发条件（满足其一到齐即启动 Tauri 迁移，作为独立项目排期）：**

- T1 后端置换完成：真实 praxisd 承载全部会话流量（praxisd-acp.md §7.1-7.2 落地）；
- T2 打包分发成为硬需求：需要 PraxisCode 品牌的独立安装包/签名/自动更新链，且
  PraxisCode 治理要求与 ER-ENG-006（Tauri 基线）对齐；
- T3 资源预算成为实测瓶颈：常驻内存被证明不可接受，且瘦身收益>迁移回归成本；
- T4 typescript-eslint/生态完成 TS7 适配（届时前端工具链可整体前移，一并评估）。

## 3. 迁移时的资产映射（预先勘定，避免届时重新调研）

| Electron 能力 | Tauri 对应 | 风险 |
|---|---|---|
| auto-update | tauri-plugin-updater | 低（需自建更新服务） |
| badge / dock | tauri API setBadge | 低 |
| app-menu / context-menu | tauri Menu API | 低 |
| BrowserView/computer-use | WKWebView 多 WebView 管理，无直接等价 | **高**——可能需保留一个 Electron 伴生进程或原生模块 |
| blocking-prompt | Rust 侧原生对话 | 中 |
| IPC（主↔渲染） | tauri command/event | 中——`website/electron/` 的 channel 协议需重写 |

**最高风险项是内嵌浏览器 + computer-use 通道**（Tauri 生态无等价物）。若届时无法
替代，可行架构是「Tauri 主壳 + 按需拉起的 headless 浏览器服务进程」，把 BrowserView
能力改为进程外服务。

## 4. 与前端基线的关系（今日已完成的对齐）

2026-10-01 已落地：**react/react-dom 19.2.0、@types/react 19.2.18、@types/react-dom
19.2.7**（与 PraxisCode ER-ENG-006 基线同版本）；Vite 已在 8.x。
**TypeScript 暂缓在 5.9.3**：TS 7（tsgo）npm 包已移除 JS Compiler API
（实测 `Object.keys(require('typescript')).length === 2`），typescript-eslint 8.71
peer 上限仍为 `<6.1.0`——强行上 7 会让 lint 体系崩溃。切换条件：typescript-eslint
官方 tsgo 支持 GA（列入 T4）。

## 5. 与 PraxisCode 治理的边界

- 本 fork 是**独立仓库**的探索/承载线，不受 PraxisCode 仓库 AGENTS.md 路径围栏约束；
- PraxisCode 自有 Workbench（若另行启动）仍以其已采纳的 ER-ENG-006
  （React 19.2 + Tauri）为准——本 ADR 的「保留 Electron」只适用于 KiroCrew fork
  这条承载线；
- 两条线若最终合流（fork 升格为 PraxisCode 正式壳），本 ADR 的触发条件 T2 即被
  满足，按 §3 映射启动迁移，并回 PraxisCode 走基线取代/修订流程。
