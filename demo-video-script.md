# Demo 视频分镜脚本 — Mindy 客服升级台(成片 ~90 秒)

场景:**Lumon**(虚构 SaaS)的 AI 客服台 **Mindy**(by EverMind)。回头客 Alex Chen 带着 webhook 429 问题回来。

- **Mindy**(frontline)= `openai/gpt-4o-mini`
- **Mindy Pro**(specialist)= `meta-llama/llama-3.3-70b-instruct`
- 升级 = **换 agent、换模型、全新 thread、零共享聊天记录** —— 专家对客户的全部了解只来自 **EverOS 长期记忆**

字幕两行:上=EverOS 价值 / 下=Convex 价值。

## 录前准备

```bash
cd example
npm run dev                        # 前端 :5173 + convex 后端
npx convex run demo:clearAll       # 每次重录先清场
```
刷新页面(新客户自动播种"上次会话"记忆);另开 `npx convex dashboard`(:6790,本地免登录)备用。

**节奏关键**:播种后 Customer memory 卡需要 ~40–60 秒填充(EverOS 异步抽取 + 组件自动重试)。开录前先等它出现 3 条带分数的事实。

## 分镜

| # | 时长 | 画面 | 操作 | 字幕(EverOS / Convex) |
|---|------|------|------|------|
| 1 | 8s | 全景。右侧 Customer memory 已有 3 条带分数事实;Activity 显示 SEED | 光标划过右栏 | "A returning customer. The agent already knows them — EverOS memory." / "The console is live Convex queries — no refresh, no websockets code." |
| 2 | 16s | 左侧对话 | 客户发:`Hi, my webhook deliveries started failing again this morning with 429 errors. Can you help?` → Mindy 回复引用了"上月提额到 10k/min" | "Frontline agent recalls last month's rate-limit history — nothing re-asked." / "Recalled context card updates live (watch the right panel)." |
| 3 | 12s | (可选)切 Convex dashboard | `everos` 组件 `pending` queued→sent;Logs 里 `runExtraction` | "EverOS ingests + extracts asynchronously." / "A Convex component: own tables + durable scheduler — zero infra to build." |
| 4 | 20s | **money shot**:点 **Escalate to specialist** | 紫色 handoff 线出现 → **Mindy Pro(Llama)开场白**点名 Alex/Pro plan/Node.js on Vercel/10k 限额,并提出针对性问题 | "New agent, new model, ZERO shared history — the specialist is already up to speed. Memory belongs to the customer, not the bot." / "Two agents, one `app.use(everos)`." |
| 5 | 12s | 右侧 Recalled context 点开 **▸ 3** | atomic facts + score + 日期展开 | "Every memory decomposes into scored, timestamped atomic facts — auditable." / "Rendered from a live query over the component's tables." |
| 6 | 10s | 右下 Memory activity | 指一遍 SEED → READ → WRITE → HANDOFF 时间线 | "The whole memory pipeline, observable." / "Every row is a Convex document — reactive by default." |
| 7 | 12s | 切 IDE `example/convex/chat.ts` | 划过 `everos.recall(...)`、`everos.asTool(...)`、escalate 里的注释 | "Drop-in memory for @convex-dev/agent." / "One component install. That's the integration." |
| 8 | 6s | 回到 app 全景收尾 | — | "Mindy — AI support that never asks twice. EverOS × Convex." |

## 为什么这个场景成立(谈判时用)

- 升级不丢上下文是客服**真实痛点**;跨 agent 共享记忆在这里不是炫技,是产品必需。
- 专家 thread 是空的 → 它知道的一切**只可能**来自 EverOS,证明干净。
- 双窗口(两个窗口同 URL)可加拍:一边操作另一边实时同步 = Convex reactivity 白送。
- 对 Convex:demo 同时是"组件生态招牌样例"(agent + everos 两个组件、调度、响应式表)。

## 注意

- 场景 2 发消息前确认 Customer memory 卡已有内容(否则 recall 为空,等 30s 再试)。
- 结尾不写 "available on npm"(未发布),写 "ready to launch"。
- 成片 1080p → Loom / YouTube unlisted,链接进 wayne-message.md。
