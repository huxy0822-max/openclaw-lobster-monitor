# 小龙虾总控台

一个给 OpenClaw 用的本地可视化监控面板。

核心目标只有一个：**不用 AI 参与查询和替换，直接在网页里管理每只小龙虾的 key、任务、Markdown、技能和运行状态。**

## 现在能做什么

- 查看每个 agent 的：
  - 累计 token
  - 今日 token
  - 最近 6 小时 token
  - 当前状态
  - 最后活动时间
  - 最后一次请求内容
  - 最近请求历史
- 直接修改每个 agent 的 `models.json` provider：
  - `apiKey`
  - `baseUrl`
- 查看和修改 heartbeat：
  - 开关
  - 间隔
  - target
  - model 覆盖
  - prompt
- 查看和修改 cron：
  - 启用 / 停用
  - 原始 JSON 直接编辑
- 查看和编辑每个 agent workspace 里的所有 `.md`
- 查看：
  - OpenClaw 全局共享 skill
  - 当前 agent 独享 skill
  - 当前 agent 实际生效 skill
- 查看并切换本机 `ai.openclaw.*` launchd 常驻服务

## 设计原则

- 只读写本地文件和本地服务
- 不走大模型，不额外耗 token
- 尽量保留 OpenClaw 原始结构，不改它的核心运行链路

## 数据来源

页面的数据全部直接来自本机这些位置：

- `~/.openclaw/openclaw.json`
- `~/.openclaw/agents/*/sessions/*.jsonl`
- `~/.openclaw/agents/*/sessions/sessions.json`
- `~/.openclaw/cron/jobs.json`
- `~/.openclaw/cron/runs/*.jsonl`
- `~/.openclaw/logs/gateway.log`
- `~/Library/LaunchAgents/ai.openclaw*.plist`
- 各 agent 的 `workspace/**/*.md`
- `~/.openclaw/skills`

## 本地运行

```bash
cd /Users/huxy/Documents/Playground
npm run start
```

默认地址：

```text
http://127.0.0.1:3199
```

开发模式：

```bash
npm run dev
```

## 项目结构

```text
.
├── server.mjs                  # HTTP 服务和 API 路由
├── lib/
│   ├── monitor-common.mjs      # 路径、原子写入、工具函数
│   ├── monitor-data.mjs        # 聚合 OpenClaw 数据
│   └── monitor-actions.mjs     # 改 key / 改 heartbeat / 改 cron / 改 md
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── README.md
```

## 已知取舍

- Cron 编辑目前是“原始 JSON 直接改”，还不是表单化编辑器
- launchd 开关是直接控制本机服务，操作会立即生效
- 页面是本地工具，不做多用户权限隔离

## 适合继续补的方向

- API key 预设池，一键把某套 key 分发到多个 agent
- cron 可视化编辑器
- 更细的 token 时间窗
- 会话筛选、搜索和导出
- 失败任务告警面板
