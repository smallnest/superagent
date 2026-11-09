# superagent 与 dsh-superagent 功能对比

本文对比两个项目：本项目 `superagent`（npm 包名 `superagent-skill`），和更早的研究原型 `dsh-superagent`
（代码在 `/Users/smallnest/dsh-superagent`）。两边各自能做什么、为什么不同，都写清楚，
关键结论标注了依据文件。

## 总结

`dsh-superagent` 是 DeepSeek Harness（DSH）的插件，跑在一个 DSH profile 里，带面板、管理 API 和 SQLite 存储。
它分两个角色：
主会话做调度，worker 会话执行每张 ticket。运维界面很全。

`superagent` 是独立的 Node 命令行工具，用 npm 安装，在命令行里跑轮询循环。状态是普通 JSON 文件，
每张 ticket 交给一个编码 agent CLI（Claude Code、Codex 或 opencode）。

两者沿用同一套模型：Trigger、Eval、Decision、带 Mandate 的 Ticket、准入规则和 observe 模式。这个项目去掉了多角色 prompt 和面板。

一句话选型：要面板、数据库、worker 交回消息、团队改 prompt，用 `dsh-superagent`；要一条命令装好、状态能直接用文件工具读，用 `superagent`。

## 两边一致的部分

两个项目都实现了 `dsh-superagent` 的 `docs/001-domain.md` 里描述的模型：

- 消息源把一条消息变成某个 Thread 上的 Trigger。
- Eval 判定 Trigger：先过确定性的 gate，再做模型评估。
- 判定结论是 Decision。accept 会创建 Ticket，Mandate 记录谁提的、凭什么。
- Assignment 把 ticket 交给执行器。执行器回报 Report，然后回复所在会话。
- 准入分两档：`explicit`（名单上的人 @ 了 agent），`inferred`（没 @ 的消息被评估匹配到已启用的规则）。
- 接受模式 `eval.mode`（本项目叫 `policy.mode`）都有 `off`、`observe`、`auto`，默认 `observe`。
- inferred 接受必须至少匹配一条已启用的规则，每条已启用规则恰好得到一次判定。
- 都有消息源范围：不在范围内的消息根本不进评估。

## 部署与运行

| | dsh-superagent | superagent |
| --- | --- | --- |
| 形态 | DSH bundle，作为插件跑在 DSH profile 里 | 独立的 Node CLI（`superagent`），从 npm 安装 |
| 安装 | 先装 `@deepseek-ai/dsh`，`pnpm build`，建 profile，再 `dsh plugin add link:$PWD` | `npm install -g superagent-skill`，再 `superagent init <dir>` |
| 依赖 | Node 22.19+、pnpm、git 2.32+、Python、tmux、gh、可选 lark-cli，DSH 版本要在 `engines.dsh` 范围内 | Node 22.19+、git、gh、可选 lark-cli、一个编码 agent CLI |
| 进程 | `dsh --profile <p>` 跑在 tmux 里，由 `scripts/dsh-superagent start\|stop\|restart\|status` 管理 | `superagent poll <dir>`，由你直接运行或挂进 cron |
| 运维入口 | 面板（`127.0.0.1:3082/orchestrator/api`）、管理 API、带 0/1/2/3 退出码的状态脚本 | `superagent init`、`status`、`doctor`、`agents`、`run -p`、`poll [--once]` |
| 定时 | 外部每小时检查一次，调用状态脚本；重启要加 `--respect-stop` | cron 或 timer 每隔一段时间跑一次 `poll --once`，每次跑一轮 |

## 消息源

| | dsh-superagent | superagent |
| --- | --- | --- |
| GitHub | 轮询通知，另外跟踪未结束 ticket 的 PR 和 CI，以及订阅的 Issue、PR 线程。收全量的开关有 `observeIssues`、`observePulls`、`observeComments`、`observeCi` | 只轮询通知：配置仓库上、名单内用户的提及 |
| 飞书 | 长连接消费事件，另有历史回填、每分钟刷新群名、订阅话题轮询。每个群可设 `listen: mentions \| all`，还有 `otherChats` | 长连接消费事件。每个群都处于收听和观察状态，可设 `directMessages` 和 `syncChat` |
| 消息源范围 | 准入表按接收位置分行：每个群、`other`、`direct`，以及 issues、pulls、comments、CI | 机器人所在的群整体视为观察；GitHub 只听配置的仓库 |
| 企业版 | 不支持 GitHub Enterprise Server | 同样的限制 |

## 谁能派活

| | dsh-superagent | superagent |
| --- | --- | --- |
| 名单 | 每个消息源一张名单，另有机器人名单，机器人只能产生 inferred 候选 | 每个消息源一张名单（`github.allowed`、`feishu.allowed`），`syncChat` 把群成员同步进来。非人类的消息在 gate 处判为 `bot`，直接拒绝 |
| 名单内，已 @ | `explicit` | `explicit` |
| 名单内，未 @ | 默认 `inferred`（`listedUnaddressed` 格） | 消息源观察到的就判 `inferred` |
| 名单外，已 @ | 按准入表格子配置，默认 `ignore` | 判 `notAllowed`，没有表格 |
| 名单外，未 @ | 按准入表格子配置，默认 `ignore` | 不进评估 |
| 规则 | 有 id、名称、启用开关和说明，在面板里编辑 | 同样定义在 `settings.yaml` 的 `policy.rules` 下。每次判断都重新读取，改完对下一条消息生效 |
| 评估者 | 主会话，带 orchestrator 的 prompt 和 14 个工具的预设 | 一次 `claude -p` 调用，只输出 JSON，不带工具，不做任何改动 |
| 评估超时 | 120 秒，重试两次，然后记 `unavailable` | 120 秒，重新排队两次，然后记 `unavailable` |

这里少的是准入表。本项目不能接纳名单外的人发的消息，也不能把机器人的消息当作候选。
准入表是 DSH 有、本项目没做的功能。

## 角色与 prompt

| | dsh-superagent | superagent |
| --- | --- | --- |
| 角色 | orchestrator（主会话）和 worker（每张 ticket 一个会话），各自有预设和工具集 | 只有一个角色：执行器。编码 agent 作为子进程跑一张 ticket |
| prompt 文件 | `prompts/` 下共 438 行，分 orchestrator、shared、subscriptions、replies、dispatch、admission、handoff 和 team 几组，有版本，可在面板编辑 | 两个常驻文件（`prompts/scope.md`、`prompts/delivery.md`），加上代码拼进去的请求正文和回报格式 |
| 选模型 | `eval.model` 和 `executor.model`，按角色单独配 | `executor.agent`（`claude`、`codex`、`opencode`），以及 `executor.model` |
| 改 prompt | 在面板里改，带历史和 diff，下一张 ticket 生效 | 直接改文件，每轮重新读取 |
| 后续消息 | worker 负责自己线程上的消息；超出范围的交回主会话（handback）重新评估 | 人发到 ticket 线程的消息变成 Input。没有 handback |

DSH 分两个角色，是因为主会话要用很多工具做判断，worker 在一个会话里干活。
本项目里，轮询循环负责判断，编码 agent 负责干活。
留下来的 prompt 只有搬过来还成立的部分：范围和交付。

## 执行

| | dsh-superagent | superagent |
| --- | --- | --- |
| 工作目录 | 每张 ticket 一个目录，在 `<stateDir>/work/<name>`，由你提供 `prepare` 命令，比如 `git worktree add` | 每张 ticket 一个 git worktree，在 `<stateDir>/work/<ticketId>`，分支名由标题生成，代码自己创建 |
| 隔离 | 以你的系统用户身份运行，`danger-full-access`；文档建议另开一个系统账户 | 以你的用户身份运行，带 `worker-bin` 里的 `gh` 和 `lark-cli` 包装脚本、可选的 `blockedCommands` 禁用列表和预备好的 git 配置 |
| 单轮上限 | 一轮结束后后台任务最多再跑 30 分钟 | `executor.timeoutMinutes`，默认 60 |
| 并发 | `executor.maxWorkers`，默认 3，另给人发的消息留一个位置 | `executor.maxWorkers`，默认 1；超出上限的 ticket 排队，等某一轮结束后再启动 |
| 回报 | `progress`、`waiting`、`ready`、`blocked`、`failed`、`dropped`，PR 通过工具绑定 | `ready`、`blocked`、`failed`，写在 `.superagent/report.json`；完整日志在 `.superagent/log.md` |
| 提问 | 用结构化的 `human_action`，由主会话以 `attention` 回复转达 | `blocked` 回报里带 `question` 字段 |
| 停止与重试 | 面板操作，或人说一句停止；重试是在同一会话、目录、分支和 PR 上新建 Assignment | Engine 里有 `stopTicket` 和 `retryTicket`，CLI 还没开放 |
| 合并 | 自动合并在 prompt 里约定，需显式开启 | prompt 规定由人合并 |

## 回复会话

| | dsh-superagent | superagent |
| --- | --- | --- |
| 用途 | `result`、`attention`、`answer`、`acknowledgement` | 同样四种，规则同样写在 `src/core/replies.ts` |
| 长度 | 最多 100 词，超了直接拒绝 | 取第一句，截到 200 字符 |
| GitHub 前缀 | 每条消息以 “This is by an automated agent, not a human” 开头 | 未实现 |
| 幂等 | 存储里有回执，发出去被丢弃的消息不再重发 | 按用途和 trigger 生成 key 的 outbox，每轮统一发送 |

## 状态与恢复

| | dsh-superagent | superagent |
| --- | --- | --- |
| 存储 | 一个 SQLite 文件，`<stateDir>/orchestrator.sqlite`，带目录锁和持久化的副作用队列 | `stateDir/` 下一个对象一个 JSON 文件，写临时文件再重命名，事务内提交 |
| 手工查看 | 不借助查询工具很难看 | `ls` 和 `cat` 就能回答“现在有什么在跑” |
| 重启 | 正在跑的 Assignment 记为“host restarted”，按最旧的 ticket 优先重启，并附恢复说明；会话保留 | 启动时，循环把上次遗留的正在运行的 Assignment 标为中断，并带上恢复说明重新启动；agent 是独立进程，所以这一轮从头开始 |
| 保留策略 | 数据行从不删除，表会一直增长 | 文件留着，直到人去删 |

## 运维体验

| | dsh-superagent | superagent |
| --- | --- | --- |
| 健康状态 | 每个组件一条健康记录（运行时、模型、评估、启动、投递、中继、回复、各消息源）。`status` 退出码 0、1、2、3 | 没有健康检查。`status` 输出 Markdown，`doctor` 检查装了哪些 agent CLI |
| 启动自检 | 探测 CLI、检查推送权限、写包装脚本、拒绝非 DSH 写出的文件 | `superagent doctor` 只检查 CLI 是否装好 |
| 查看未 @ 消息的判定 | 面板的 Source、Trigger、Eval、Execution 几个页签 | `superagent status` 列出最近 10 条 inferred 判定，包括 observe 模式下的“本来会接” |
| 测试 | 60 多个 Vitest 用例，包含面板测试和模拟宿主测试，`pnpm check` 一把跑完 | 44 个 Vitest 用例，包含用替身 `gh` 和 `lark-cli` 跑完整一轮，`pnpm check` 一把跑完 |
| CI | 仓库里没有 | 仓库里没有 |

## 本项目还缺的功能

- **准入表**：不能按行列接纳名单外的发件人。
- **后续消息与 handback**：worker 不能把消息交回去重新判定。
- **面板与管理 API**：没有界面，没有管理 API，也没有按组件的健康记录。
- **命令行重试与停止**：Engine 里有，命令还没开放。
- **会话**：重启后这一轮从头开始。编码 agent CLI 没有可恢复的会话，恢复说明会让它先查看 worktree 和 git 历史。
- **GitHub PR 与 CI 跟踪**：agent 会开 PR，但循环不跟踪 PR 的检查结果。

## 本项目更简单的地方

- **安装**：npm 装完，`superagent init` 就能用。DSH 那套需要 DSH、profile、插件链接、tmux 和 Python。
- **状态可读**：整个状态目录都能直接用文件工具读。
- **评估者隔离**：评估是一次只读的模型调用。DSH 的准入 prompt 跑在负责派活的同一个会话里。
- **按现场问题迭代**：每遇到一种情况，就直接改代码和测试。
  比如飞书消息在某一轮中途到达，或者一轮结束后回报才回来。

## 已知问题

- **飞书推送**：写这份文档的机器上，`lark-cli event consume` 收不到人在群里发的消息，收到 0 条事件。
  而机器人自己发的消息，能用 `im +messages-search` 查到。原因还没确认。
  飞书链路目前只用替身 CLI 验证过，另外用真实机器人验证过一次 @ 的消息。
- **评估成本**：每条未 @ 的消息都会消耗一次 `claude -p` 调用，observe 模式也一样。
  群里闲聊多时，模型调用会不少。
