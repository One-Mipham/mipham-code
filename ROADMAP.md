# ROADMAP

> **定位**: 从「工程纪律已经不错」走到「可证明、可观测、可售卖」的推进清单
> **建立**: 2026-09-15
> **维护人**: One Mipham Corporation 技术委员会
> **基线版本**: v0.81.7

本文件记录**尚未做**的事，不记录已完成的事实（那些在 [`CLAUDE.md`](./CLAUDE.md) 与
[`docs/claude-md-history.md`](./docs/claude-md-history.md)）。任务用 `T<n>` 编号，稳定不变，
便于在提交信息与 issue 里引用。

> ⚠️ **本文件已自动进入完整性守卫的扫描面**。`apps/cli/test/integrity/tool-reference-integrity.test.ts:174`
> 的 `liveDocs` 会扫描**根目录下除 `CHANGELOG.md` / `PRODUCT.md` 之外的全部 `.md`**，
> 其中 `TOOL_TOTAL_RE` 校验形如 `N 个工具` / `N tools` 的声明必须等于注册表实际数量。
> 在本文件里写这类数字**必须准确**，否则守卫会红 —— 这是设计如此，不是障碍。

---

## 基线：当前证据面（决定下面各项的必要性）

| 维度            | 现状                                                                                                                                                                                                                                                                                   | 判定                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 测试            | 2809（2807 passed + 2 skipped），244 文件（另有 `apps/telemetry` 独立工作区 179 用例 / 12 文件）                                                                                                                                                                                       | ✅ 数量充足                                                            |
| CI              | 9 job：typecheck / lint / format / build-cli / build-web / test / security-audit / penetration-test / install-scripts                                                                                                                                                                  | ✅ 齐全                                                                |
| 覆盖率          | 本地（有 API key）行 56.76% / 分支 47.8% / 函数 62.35% / 语句 56.54%（2026-09-15 T1 落地后实测；阈值仍取 CI 条件值）                                                                                                                                                                   | ✅ 偏低但**已有阈值门禁 + CI 执行路径**（T3a，2026-09-15）             |
| 变异测试        | **基线 7.05%**（144 killed / 1507 survived / 393 no-coverage，共 2044 变异体 · **7 文件全接** · 实跑 8m26s，2026-09-15）；**口径已变，不与首批 8.02% 比**（首批 6 文件 / 1621 变异体 —— 是加文件稀释，不是回归）；**这是起点不是目标** —— `break` 阈值故意未设，待办是补断言而非调阈值 | ⚠️ 有基线、**分数很低**（T3c，2026-09-15）                             |
| ESLint          | type-checked 已接：`projectService` + `allowDefaultProject`，`no-floating-promises` 钉在 **`error`**（只开这一条）                                                                                                                                                                     | ✅ 已有（T3b，2026-09-15）                                             |
| 遥测 / 崩溃上报 | **端到端已通**：CLI 默认关闭（零出网有断言）+ 官方接收端 `log.onemipham.com` 已上线（只存按接收日分区的维度聚合，公开只写、无读端点）—— T1 + T1b 均于 2026-09-15 落地；**已知偏离：该端点实际 TLS 1.2+1.3（§二 例外申请范畴）**                                                        | ✅ 已上线（数据积累中；T4 已于同日落地，**未用到投票** —— 见 T4 条目） |
| 公开基准成绩    | **无**（从未跑过 SWE-bench / Terminal-Bench）                                                                                                                                                                                                                                          | ❌ 缺                                                                  |
| 文档数字守卫    | `test/integrity/` 6 个守卫文件（另有 1 个 fixture 文件不算在内）                                                                                                                                                                                                                       | ✅ 高于业界均值                                                        |

**两句话诊断**：在「工程纪律」这条线上已经超过多数同类；但在「**可证明性**」（基准成绩）与
「**可观测性**」（遥测）上几乎是零 —— 而市场只认这两样。

---

## P0 — 生产级门槛

### [x] T1 · 遥测 + 崩溃上报 ✅ 已于 2026-09-15 落地（CLI 侧；接收端另立 T1b）

**为什么**：这是「怎么知道这一大堆文件都有效、有价值」唯一能回答**第三层（价值）**的工具。
没有它，任何关于"死代码/无用功能"的判断都只是猜测。

**落点**

- 新增 `apps/cli/src/telemetry/`
- 复用 `src/config/loader.ts`（配置读取）+ settings.json（`/permissions` 已有落盘先例）作开关持久化
- `src/core/paths.ts`（目录名唯一真源）落本地队列

**最小可用**

- 命令级计数器：各 slash 命令、各工具被调用的次数
- 崩溃栈上报
- 匿名安装 ID（首次生成，可重置）
- **opt-in**：首次运行询问，默认关闭

**硬约束（合规，不可让步）**

- 默认关闭；`MIPHAM_TELEMETRY=off` 时**零网络请求**（写成断言测试，不是口头承诺）
- 采集字段写入文档（数据字典）
- 遵循集团 §二：PII 脱敏、TLS 1.3、禁止硬编码凭据

**验收**

- 关闭状态下无任何出网（测试可证）
- 本地队列 + 批量上报 + 失败静默重试（不阻塞主流程）
- 数据字典入库

**前置**：✅ **已定（2026-09-15）** —— 上报到**自建端点**（决议记录见文末「已决议的岔路口」）。这条路径把合规面收敛进自有基础设施：第三方 SDK 的 DPA / 数据出境条款不再适用，数据不出自有域名。**代价须一并认下** —— 端点不是既有资产，属本项的**新增待建内容**（接收侧 + 存储 + 自有域名 + TLS 1.3），下方估量里的「+ 端点」即指此事。

**估量**：中（1–2 天 + 端点）

---

### [x] T1b · 遥测接收端上线 ✅ 已于 2026-09-15 落地

**落点**：`apps/telemetry/` → `https://log.onemipham.com/v1/events`（主机 2，nginx 终结 TLS，
反代 `127.0.0.1:9099`，Node 22 + systemd）。**公开、只写、无读端点** —— CLI 带不了凭据
（客户端发到 npm），所以防护面全在「能往里写什么」：服务端 allowlist 收敛 label，
**原始 label 一个字节不落盘**；`installId` 只喂 HLL；分区键是**服务端接收日（UTC）**
（客户端 `occurredAt` 不可信，只进偏移桶）。落盘为按日 AES-256-GCM 加密。

**上线验收（2026-09-15 实机）**：`deploy.sh --check` = no drift；服务 `active`，
journald `key=e2bebea5` 与 `keys init` 指纹一致；真 CLI 端到端两跑 ⇒ 第一条被 ack 删条、
报告侧 `bodies parsed 2 / events accepted 2 / sessions 2 / distinct installs 2`，
`unknown` 与 `discarded` 全 0。

**如实记录的偏离（须按集团 §二 走例外申请）**：本端点实际是 **TLS 1.2 + 1.3，不是 1.3-only**。
主机 2 的 nginx 1.24.0 上，同一 443 地址的握手版本由**该地址的默认 server（api）**决定 ——
版本在 OpenSSL 处理 ClientHello 时定死，早于 nginx 的 SNI 回调；官方按 wontfix 关过
trac #844 / #2352，直到 1.29.2 才修。故 vhost 里写 `TLSv1.3;` 是**无效的**，
现在的写法是如实声明 `TLSv1.2 TLSv1.3;`（行为不变、配置不说谎、将来升 nginx 也不会
突然改变行为）。套件仍为前向安全的 ECDHE-ECDSA-AES\*-GCM；遥测只收维度聚合，不含金融数据。
细节与证据见 `apps/telemetry/deploy/README.md`「已知的诚实边界」。

**与 `T4` 的分工（本轮写死，防下次误用）**：遥测**不能**对 `T4` 第 4 步的全部对象投票。

- `T4` 第 4 步限定为「**command / tool 形态的功能**」—— 这两类有计数器，遥测对它们有票
- `task-runner` / 双轨 Runtime / `plan-runner` 这三个**子系统**的存在性判定**改用 knip 的
  未接线清单**（它已给出 4 条真未接线，那本身就是存在性证据）。**本批不加计数器**：
  为「证明某子系统没人用」而新增计数器，等于先污染采集口径再去读它

**结局（2026-09-15 T4 落地后回填）**：这条分工按预期生效 —— T4 实跑出的 5 条真未接线
**全部**落在这三个子系统里，一条都没用遥测投票，也没新增任何计数器。

**诚实的边界**：`204` 不代表已持久化（每 25 条 / 10s 才 flush）；**崩溃通道永远不能告诉你
崩在哪一行**（客户端自 v2 起不再发帧，服务端从来不存 —— 见 `docs/telemetry.md`）。

**估量**：小–中（端点本体已建，本轮为部署 + 文档）

---

### [ ] T2 · 公开一份可复现的基准成绩 ⭐ 最高杠杆

**为什么**：市场无法给未排名的产品定价。哪怕分数不领先，**有数字**就能进入可比较的牌桌。
这是最省钱的品牌素材 —— 价值高于任何单次功能发布。

**基准已定（岔路口 #2 于 2026-09-16 关闭）**：**Terminal-Bench**（更贴近 agent 真实形态）。同批定下三件：发布模型 = **`deepseek-v4-pro`**（第三方，产品判断 —— 真实基准走成熟模型，成绩才可解释、可复现）；开工规模 = **10 题 × k=1**；接入路线 = **A+**（修 daemon 自启 + Harbor 适配器直驱 daemon REST API）。设计规格 `docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md`（spike 已验通仪器：官方现役数据集 **66 题**、预置镜像、oracle 基线 1.000）。

**落点**：新增 `benchmarks/` + 根 `README.md` + 两站产品页

**诚实披露项（缺一不可，否则数字没有公信力）**

- scaffold 是什么（同一模型换 harness 分数可差很多）
- `pass@1` 还是 `pass@k`
- 每任务 token / 成本
- 复现命令与随机种子

**前置**：① Docker 干净环境（官方 harness 需容器）；② **基准 daemon 的权限策略 —— ✅ 已定（2026-09-15）**：`bypassPermissions` 走进程级 `MIPHAM_DAEMON_PERMISSION`，配专用 daemon + 临时工作区 + 跑完即杀（决议与行为实证见文末「已决议的岔路口」）。**发布物必须写明 mode 与该行 env** —— 不写，第三方复现不出同一份成绩；③ **工具成败位可读 —— ✅ 已落地（T12，2026-09-16 结项）**：不解决则低分时分不清「模型没做出来」与「我们的权限层把工具吃了」，分数报得出、辩护不了；④ **产物里 daemon 真起得来 —— ✅ 已落地（T2 Plan A，2026-09-16 推送，2.50.0）**：官方 harness 跑的是**编译产物**，而自启原依赖 PATH 上的 `bun`、且判别式在产物里恒把 `$bunfs` 入口读成首个用户参数 ⇒ **基准根本起不来**，且起不来时还谎报成功。修法与验收见文末变更记录。

**验收**：第三方可按文档复现出同量级分数

**估量**：中（harness 集成 + 跑分 + 写报告）

---

### [x] T3a · 覆盖率门禁 ✅ 已于 2026-09-15 落地

**为什么**：成本最小、不依赖任何决策。存在**两个真实缺口**（初版只写了第一个的一半，
2026-09-15 实测后修正）：

1. **没有 thresholds** —— `apps/cli/vitest.config.ts` 里没有 `coverage` 块，覆盖率配置
   全部散在 `package.json` 的 `coverage` 脚本命令行上（provider / include / reporter
   都在那儿）。没有任何阈值 ⇒ **门禁不存在**。
   ⚠️ 更正：`--coverage.include` **是写了**的，所以「只报已加载文件」**不是**当前问题
   （初版此处说错）。真缺陷是**缺阈值**，以及配置不落在 config 文件里 —— 于是只有
   `pnpm coverage` 这一条调用路径能带上完整配置。
2. **CI 根本不跑覆盖率** —— `.github/workflows/ci.yml` 的 test job 是 `pnpm -r test`
   （= `vitest run`），**没有 `--coverage`**。于是即使加了阈值也**没有任何执行路径**会
   去执行它 —— 这正是本仓库刚修完的 `rules-loader` 那类「有定义、无调用点」缺陷的同型。
   **门禁必须两半都做，否则只是造了个空转的守卫。**

**落点**：`apps/cli/vitest.config.ts`（配置归位 + 阈值）、`apps/cli/package.json`
（脚本瘦身）、`.github/workflows/ci.yml`（接上执行路径）

**顺序（不可颠倒）**

1. 把 provider / include / reporter 归位到 `vitest.config.ts`，测出**真实基线**
2. 阈值从真实基线**回退一档**起步（先绿），再逐步抬升
3. CI 接上执行路径 —— 否则阈值只是死配置

**真实基线（2026-09-15 实测）**

| 指标 | 本地（有 API key）   | **CI 条件（无 key）** ← 阈值取此 |
| ---- | -------------------- | -------------------------------- |
| 语句 | 56.19%（9773/17390） | **55.87%**（9717/17390）         |
| 分支 | 47.34%（4885/10317） | **46.81%**（4830/10317）         |
| 函数 | 62.00%（1746/2816）  | **61.82%**（1741/2816）          |
| 行   | 56.46%（8951/15853） | **56.14%**（8900/15853）         |

必须取 CI 列：本地有 API key 时 `test/e2e/full-pipeline.test.ts` 真跑（8 个测试），
各项比 CI 高约 0.3 个点。照本地值设阈值 ⇒ **CI 必红**。

**验收**：阈值生效，且 **CI 因它变红/变绿**（要一次真实的红绿验证，不能只写配置）

**估量**：小（半天）

**✅ 落地结果（2026-09-15）**

- `apps/cli/vitest.config.ts` 增 `coverage` 块（provider v8 / include / reporter）+ `thresholds`
- `apps/cli/package.json` 的 `coverage` 脚本瘦身为 `vitest run --coverage`（配置已归位到 config 文件）
- `.github/workflows/ci.yml` 的 test job 由 `pnpm -r test` 拆为
  `pnpm -r --filter '!@miphamai/cli' test` + `pnpm --filter @miphamai/cli coverage`
  —— **执行路径接上了**，阈值不再是无调用点的死配置
- 阈值：行 54 · 语句 54 · 函数 59 · 分支 44（CI 实测值各回退一档）
- **红绿验证**（三步实跑）：真实阈值 → 退出码 0；`lines` 临时抬到 99 → 退出码 1
  且报 `Coverage for lines (56.14%) does not meet global threshold (99%)`；还原 → 退出码 0
- **棘轮约定**：阈值只升不降。为让它变绿而下调阈值 = 拆掉门禁本身（已写进 config 注释）

---

### [x] T3b · 开 ESLint type-checked ✅ 已于 2026-09-15 落地

**为什么**：当时 `eslint.config.*` 里 `projectService` 完全没接 —— 一整类异步 bug
（`no-floating-promises` 等）静默通过。

**落点**：`eslint.config.*`

**做法**：**只先开 `no-floating-promises` 一条**，渐进。不要一次开
`recommendedTypeChecked` 全套，否则既有问题一次爆几百条，变成噪音而无法收敛。

**验收**：该规则生效并有测试证明（造一个 floating promise 会被 lint 拦下）

**估量**：中（需分批清理既有告警）

**实测（落地时记录，纠正了上方的估量）**：`no-floating-promises` 的既有告警**不是
「几百条」**，是 14 条 + 5 个**解析错**（`projectService` 下不在任何 tsconfig 里的文件会整份
抛错、**其所有规则静默失效** —— 一整个「有定义、无施加」的新形态）。三项落地要点：

1. **规则必须落 `error`，不能落 `warn`**：根 lint 脚本是裸 `eslint .`、**无 `--max-warnings`**
   ⇒ 写成 `warn` 等于零强制（本仓库第三次踩「有定义、无调用点」：`rules-loader`、覆盖率阈值前两次）。
2. **`allowDefaultProject` 不是可选项**：`apps/cli/scripts/*.ts` / `vitest.config.ts` /
   `vitest.setup.ts` 都不在任何 tsconfig 里，不列进白名单则它们整份文件失效 —— 补上之后
   立刻浮出一个真悬挂 Promise（`sync-mipham-models.ts`），此前被解析错掩盖。
3. **15 处修法按语义分类，不搞一刀切**：`void` 标记 9 处（刻意的 fire-and-forget，其中
   `mcp/client.ts` 的 `disconnect()` 是**同步**签名、**无法** await）、补 `.catch()` 2 处
   （注释承诺了「离线静默失败」却没有 catch）、`await` 3 处（顺序确实错了）。

**验收证明**：`apps/cli/test/integrity/lint-rules.test.ts` + fixture —— **不能用「仓库 lint 绿」
当证明**，因为 fixture 被 `eslint .` 忽略，规则配置错了仓库照样绿。该测试以
`overrideConfigFile: true` 加内联配置重跑 fixture，断言恰好报出这条规则。

---

### [x] T3c · 变异测试 ✅ 已于 2026-09-15 落地（**范围 7 文件**，分两批：首批 6 + 第二批 `crsi-sandbox.ts`）

**为什么**：覆盖率只证明「行**被执行过**」，不证明「**测得住**」。两者差距在核心安全逻辑上尤其危险。

**落点**：新增 Stryker 配置（TS 支持成熟）

**范围**：**只跑 `src/core/crsi-*` + `src/core/permission*`**，不全量 —— 全量成本高且收益边际递减

> ⚠️ **落地时曾对该范围做了一次收窄**（范围本身不变，交付**分两批**）：`crsi-sandbox.ts` 曾挪到
> 第二批。**收窄理由已被实测证伪，该文件已于 2026-09-15 同日归还第二批** —— 详见下方「范围
> 收窄」，那里逐字保留了当时的判断，并写明它错在哪个未经查证的默认上。

**验收**：核心安全模块的 mutation score 有基线数字，并纳入趋势观察

**估量**：中

**✅ 落地结果（2026-09-15）**

**落点**：`apps/cli/stryker.config.json`（新）· `apps/cli/package.json`（`mutate` 脚本 + 两个
devDependency）· `apps/cli/test/integrity/mutation-wiring.test.ts`（新守卫，防范围静默腐烂）·
`.gitignore`（`.stryker-tmp/`、`reports/`）· `eslint.config.js`（忽略 `**/.stryker-tmp/**` ——
见下方「第四个坑」）。**零生产依赖** —— Stryker 只在 devDependencies。

**真实基线（实跑，非估计）** —— `cd apps/cli && pnpm mutate`，退出码 **0**，**全程 8 分 55 秒**：

| 文件                    | 变异体   | killed  | survived | no-coverage | score     |
| ----------------------- | -------- | ------- | -------- | ----------- | --------- |
| `crsi-managed-rules.ts` | 17       | 7       | 9        | 1           | 41.18%    |
| `crsi-producer.ts`      | 454      | 60      | 387      | 7           | 13.22%    |
| `permission-config.ts`  | 68       | 7       | 58       | 3           | 10.29%    |
| `permission-rules.ts`   | 589      | 48      | 528      | 13          | 8.15%     |
| `permission.ts`         | 416      | 8       | 253      | 155         | 1.92%     |
| `crsi-modify.ts`        | 77       | 0       | 76       | 1           | 0.00%     |
| **合计**                | **1621** | **130** | **1311** | **180**     | **8.02%** |

按「被覆盖变异体」口径是 9.02%（130 / 1441）。0 timeout、0 error。

**第二批基线 + 一个把「能不能比趋势」这件事钉死的对照实验（2026-09-15 同日）**

`crsi-sandbox.ts` 归还后的完整范围基线（`cd apps/cli && pnpm mutate`，退出码 **0**，**8 分 26 秒**）：

| 文件                    | 变异体   | killed  | survived | no-coverage | score     |
| ----------------------- | -------- | ------- | -------- | ----------- | --------- |
| `crsi-managed-rules.ts` | 17       | 8       | 8        | 1           | 47.06%    |
| `crsi-modify.ts`        | 77       | 0       | 76       | 1           | 0.00%     |
| `crsi-producer.ts`      | 454      | 55      | 392      | 7           | 12.11%    |
| `crsi-sandbox.ts`       | 423      | 19      | 191      | 213         | 4.49%     |
| `permission-config.ts`  | 68       | 7       | 58       | 3           | 10.29%    |
| `permission-rules.ts`   | 589      | 47      | 529      | 13          | 7.98%     |
| `permission.ts`         | 416      | 8       | 253      | 155         | 1.92%     |
| **合计**                | **2044** | **144** | **1507** | **393**     | **7.05%** |

按「被覆盖变异体」口径是 8.72%（144 / 1651）。0 timeout、0 error。

**7.05% 与 8.02% 不可比 —— 但理由不是「换了配置」，而主要是「这个读数本身会飘」。** 两步：

1. **成分效应（可精确算，且这条是稳的）**：`crsi-sandbox.ts` 是 423 变异体、19 killed = 4.49%，
   **低于平均值** ⇒ 并进来是分子分母同时变大而新入那块更差 ⇒ **稀释**。8.02% → 7.05% 里属于
   这一部分的变化，与测试强弱无关。
2. **同一份配置复跑，分数会动，而且比原先记录的大得多。** 这一步是把「不可比」从推论变成实测的
   关键：拿**完全相同的 6 文件范围**（用 `--mutate` 覆盖，不动配置文件）重跑 ⇒ **137 killed /
   8.45%**，而批次一记录的是 **130 / 8.02%**。**同一配置，killed 差 7 个。**

   逐文件三方并列（都是实跑印出来的表，不涉及任何 id 对齐）：

   | 文件                    | 批次一（6 文件） | 批次二共有子集（7 文件） | 对照实验（6 文件） |
   | ----------------------- | ---------------- | ------------------------ | ------------------ |
   | `crsi-managed-rules.ts` | 7                | 8                        | 8                  |
   | `crsi-modify.ts`        | 0                | 0                        | 0                  |
   | `crsi-producer.ts`      | 60               | 55                       | **64**             |
   | `permission-config.ts`  | 7                | 7                        | **9**              |
   | `permission-rules.ts`   | 48               | 47                       | 48                 |
   | `permission.ts`         | 8                | 8                        | 8                  |
   | **killed 合计**         | **130**          | **125**                  | **137**            |

   抖动几乎全落在 `crsi-producer.ts`（55–64，极差 **9**）与 `permission-config.ts`（7–9）上；
   `crsi-modify.ts` 与 `permission.ts` 三次一字不差。

   ⇒ **上方「读数纪律」第 2 条必须改**：原文写「±1 抖动（同配置 4 跑：3 次 5 killed / 1 次
   6 killed）…摊到 1621 上是 0.06 个点，对基线无实质影响」。**那是在单文件上量的，低估了整批的
   量级** —— 整批同配置实测差 **7** 个（0.43 个点），是它的 **7 倍**。机制仍未定（与批次一
   「怀疑某测试在插桩下偶发」一致，本轮**未取证**）。

**顺带更正一条我差点写进文档的错误因果**：批次二跑完时共有子集是 125 killed，我据此准备写
「加 `crsi-sandbox.ts` 进 `mutate` ⇒ 静态变异体相关集变化 ⇒ −5」。**对照实验直接证伪了它** ——
同一份 6 文件配置复跑得到 **137**，比 130 还**高**。那 5 个（连方向）整体落在测量噪声里，**不可
归因**。教训值得单列：**在两个各自带 ±7 噪声的读数之间做减法，减出来的不是效应量，是噪声的差。**

（本轮曾试图用 `reports/mutation/mutation.json` 做逐变异体 diff 来定位翻转机制，**方法本身是错的**：
变异体 `id` 按 `mutate` 清单顺序全局递增，批次二中间插了 `crsi-sandbox.ts` 会把其后所有文件的 id
推移 ⇒ 按 id 对齐等于拿错位的行相比（首次比对只匹配上 700/1621 却"成功"输出了 58 个翻转，全是假的；
改用位置键后匹配回 1621，但位置键又会把同位置同名变异体折叠）。**结论：这份 JSON 不是跨运行比对
的可靠载体，别再用它做 diff。** 上面的三方表格才是可信来源。）

**这个分数低，但它是真信号，不是配置错**。已举证的例子：`permission.ts` 的 `nextMode`
环绕方向 `(idx + 1) % len` → `(idx - 1) % len` **存活** —— 权限模式循环的方向从未被断言过；
`private mode = 'default'` → `''` 也存活（136 个测试覆盖到它，却没有一个在 `setMode` 之前
断言过初值）。**修这些是独立工作**（用测试补断言），要按安全优先级排序，**不在本项范围** ——
本项只交付**基线**，好让「补到多少」有参照物。

**范围收窄：`crsi-sandbox.ts` 曾延后到第二批 —— 理由已被实测证伪，已归还（2026-09-15）**

> **当时的判断（逐字保留，供后人核对）**：`runTests()` 在临时 worktree 里跑**整套**套件
> （`execSync('pnpm test')`，120s 超时），踩到该路径的每个变异体都要付一次全量测试；其测试
> 还会**在建仓上真的创建 git worktree**。该文件 682 行，足以独自吃光整个预算、并在跑动期间
> 反复动真仓库。

**这段推理听起来无懈可击，但它默认了一件从未查证的事：有人覆盖那条路径。** 实测四点：

- `runTests()` 的唯一生产调用点是 `crsi-modify.ts:92`，而它在 `crsi-modify.test.ts` 里被 **6 处**
  `vi.spyOn(sandbox, 'runTests').mockReturnValue(...)`（行 55 / 77 / 109 / 139 / 168 / 213）**整个
  mock 掉**；`crsi-sandbox.test.ts` 提到 `runTests` 的次数是 **0**。
- ⇒ `runTests()` 方法体（`crsi-sandbox.ts:360` 起，至 `:425` 的 `getDiff()` 前）的变异体**全部落
  `NoCoverage`**，而 Stryker 对 no-coverage 变异体**什么都不跑**。「每个踩到该路径的变异体都要付
  一次全量」里的「踩到该路径的变异体」—— **一个都不存在**。
- 真实成本在别处且可承受：`crsi-sandbox.test.ts` 确在约 20 处真 `git worktree add`（30s 超时），
  但那些是**动态**变异体的测试，走 `vitest.related` 收窄后的相关集。
- **代价实测**：干跑 423 变异体；并进批次后总数 **1621 → 2044（正好 +423）**，no-coverage
  **180 → 393（+213**，全部来自上面那段没人覆盖的 `runTests()` 体），而**全程耗时 8m55s →
  8m26s，不升反降**。

**教训（与 `rules-loader`、双轨 Runtime 同源）：「这机制的代价」要先查「谁在用它」。** 一个听起来
昂贵的代价，如果那条路径根本没有测试覆盖，那它实际是**零** —— 而且免费顺带告诉你「这段代码测试
完全够不着」（这正是 `NoCoverage` 该被读成的意思：**不是**「这段代码不值得测」，是「**没人测**」）。

这张「延后表」在守卫里仍是**明写**的（`DEFERRED_TO_BATCH_2`，现为**空数组**）：它的价值是**形状**，
不是内容 —— 下次真要延后谁，往这里加一项即被守卫可见地记下，而不是让 `mutate` 悄悄少一个文件。

**`vitest.related` 让干跑只跑了 534 个测试 —— 两个方向都已核对**

干跑输出是 `Ran 534 tests`，而全量套件是 2525（**跑基线那一刻**的数；本批落地后为 2533）。
差距来自 vitest-runner 的 `vitest.related`
（默认 `true`，配置里没有、也不该有）：只跑**（传递）import 了被测文件**的测试文件，
本次为 **38 / 225** 个。

- **它必须留着**：关掉它，「每个变异体跑全套件」会把 `crsi-sandbox.test.ts` 拉进来 ——
  那个测试真开 git worktree、真跑 `pnpm test`，等于把上面刚延后的炸弹塞回每一轮。这轮
  9 分钟而不是几小时，靠的就是它。
- **对动态变异体它是无损的**（已逐文件核对）：其余 187 个测试文件里只有 2 个提到这 6 个模块，
  且**都没有 import 它们**（`crsi-sandbox.test.ts` 只把它们的路径当字符串字面量断言，
  `mutation-wiring.test.ts` 只读配置与目录名）—— 不执行 ⇒ 不可能杀掉变异体。

**两条必须写下来的读数纪律（都是实测出来的，不是推想）**

1. **静态变异体的死活取决于整套 `mutate` 范围，不是单看这个文件**。模块级变异体（本次
   213 / 1621 = 13%，却占约 88% 的时间）没有 `coveredBy`，Stryker 对它们跑的是**本次运行
   相关集里的全部测试**。实测把 `crsi-managed-rules.ts` 单独当靶子：41.18% → 35.29%，
   两个静态变异体失去了杀死它们的测试。⇒ **趋势观察必须固定同一份 `mutate` 清单**，
   范围一变，分数会跟着变，而那与测试变强变弱无关。
   （⚠️ **2026-09-15 补注**：这条的机制是结构性的（静态变异体无 `coveredBy` ⇒ 跑本次相关集全部
   测试，Stryker 文档亦然），**但上面那次实测的差值只有 1 个变异体**（7/17 → 6/17），落在下面第 2
   条量到的噪声里 ⇒ **它证不了这条机制**。机制可信，这次的证据不可信，分开记。）
2. **同配置复跑会飘，量级远大于 ±1 —— 已实测量化**。批次一时只在**单文件**上量到 ±1
   （`crsi-managed-rules.ts` 复跑 4 次：3 次 5 killed / 1 次 6 killed），当时据此写下「摊到 1621
   上是 0.06 个点，对基线无实质影响」。**这个外推是错的**：2026-09-15 第二批落地当天，把**完全相同
   的 6 文件范围**复跑一次 ⇒ killed **130 → 137**（差 **7** 个 = **0.43 个点**，是单文件读数的
   **7 倍**）；误差集中在 `crsi-producer.ts`（55–64）与 `permission-config.ts`（7–9）上，
   而 `crsi-modify.ts` / `permission.ts` 三次一字不差。机制未定（未取证）。
   ⇒ 两条禁令：**单文件级百分比不能当精确值读**；**整批级 <0.5 个点的差异不可解释**，更不要当回归。
   **单文件上量到的抖动幅度不能外推到整批 —— 本轮正是这么错了一次。**

**静态变异体：不忽略**

Stryker 警告 `213 static mutants (13% of total) that are estimated to take 88% of the time`。
**没有**开 `ignoreStatic`：这些模块级常量（如 `MANAGED_DANGEROUS_RE`）恰恰是最该被变异的
安全内容。代价（跑得慢）认下，换来的是这几个常量真的被检验过。

**落地时踩到的四个坑（前三个同一根因：路径与沙箱深度耦合）**

Stryker 把整个包复制到 `apps/cli/.stryker-tmp/sandbox-<id>/` 里跑 —— 比真实树**深一层**。
凡是靠数 `..` 或写死相对路径定位仓库根的地方都会静默指错：

1. `telemetry-contract.test.ts` 的 `join(CLI_DIR, '..', '..')` 在沙箱里指到 `apps/cli`
   ⇒ `apps/telemetry/src/allowlist.json` ENOENT，干跑直接失败。修法：以 `pnpm-workspace.yaml`
   为锚**向上走到仓库根**（`findRepoRoot`），与嵌套深度无关。
2. `init-providers.test.ts` 用 `process.chdir()`，而 vitest-runner 把测试跑在 worker 线程里
   （`pool: 'threads'` 在它源码里**写死**、无覆盖入口），线程里 chdir 直接抛
   `process.chdir() is not supported in workers`。修法：改为 spy `process.cwd()`，
   两种跑池下行为一致（顺带去掉一处进程级可变状态）。
3. `telemetry-contract.test.ts` 的 11 处字面量动态 import `'../../../../apps/telemetry/src/…'`
   在沙箱里解析成 `/apps/telemetry/…`。修法：改为锚在 `TELEMETRY_DIR` 的绝对路径，
   类型位用 `import type` 保留（类型位在转换时被擦除，只有 `tsc` 读它，而 `tsc` 永远在真树里跑）。

第 1 个形态在 `lint-rules.test.ts` 上还有一个**最阴的变体**：它算出的根会交给
`parserOptions.tsconfigRootDir`，指错则 type-aware 规则**静默失效** —— 而该文件存在的唯一
目的就是证明那条规则能咬人。三个文件统一改成标记锚定的 `findRepoRoot`，每个文件自带
（全仓库守卫的既定约定：守卫文件自足，不抽公共模块）。

**第四个坑（性质不同：沙箱会留下来砸别人）**

前面三个坑是「跑的时候读错路径」，第四个是「跑完之后东西还在」。`.stryker-tmp/sandbox-<id>/`
**不保证被清掉**：Stryker 只在**运行成功**后才删临时目录（`stryker.js` 的出错路径把
`removeDuringDisposal` 置 false，`temporary-directory.js` 据此跳过 `rm`）。本轮实测留下
**3 个目录 / 269 MB**，每个都是 `apps/cli` 的整份副本（含 `node_modules`、`dist`、`coverage`）。
而 **ESLint 不读 `.gitignore`**（与 `.mipham/task-runner-test/solution.ts` 同一个 dotfile 陷阱），
于是 `pnpm lint` **凭空报 1809 个 error**，全部来自没人编辑过的副本 —— 这正是「配置 + 施加点」
在**工具侧**的同一条教训：`.gitignore` 只挡得住提交与 Prettier（Prettier 3 默认读 `.gitignore`），
挡不住 ESLint。修法两条都做：`eslint.config.js` 加 `**/.stryker-tmp/**`（未来每一轮靠它），
并手动清掉已遗留的那 269 MB（lint 与 grep/rg 都不该看见第二份源码副本）。

**红绿验证（实跑）**

- 变异跑**能真的红**：临时 `thresholds.break = 99` 实跑 ⇒ 退出码 **1**，报
  `Final mutation score 35.29 under breaking threshold 99, setting exit code to 1 (failure)`
- CI 活性守卫**能真的红**：把 `mutate` 指向不存在的路径 ⇒ `mutation-wiring.test.ts` 红
- 还原后：`pnpm mutate` 退出码 0、守卫全绿

**棘轮约定**：**暂时不设 `break` 阈值** —— 分数未知前设阈值是赌博，且会让本地按需运行随时
变红。将来上棘轮时，`stryker.config.json` 与守卫里那条 `break === null` 断言**一起改**，
改就是一次显式动作。同 T3a：阈值只升不降。

**已知前置（不满足时表现为干跑失败、整轮中止）**

- 必须在 `apps/cli` 下跑（`cd apps/cli && pnpm mutate`）。从仓库根跑会踩 `CLAUDE.md` 记载的
  31 个假红陷阱，而变异跑继承同一套测试 —— 先要在同一位置跑绿。
- `core/crsi-*` 的 21 个测试 shell 调真 `git`，Xcode 许可证未接受时整体假红（本机已接受）。

**第二批（待办，需单独决策）**：`crsi-sandbox.ts` —— 先实测单跑耗时与副作用，再决定整体
纳入、还是对其子进程区域用 `// Stryker disable` 隔离（给安全代码加 disable 标注本身需要理由）。

---

### [x] T4 · 死代码 / 价值盘点 ✅ 已于 2026-09-15 落地（四步协议跑完一次）

**为什么**：标准 DevOps 工具链**回答不了「这文件活着吗」**。本仓库自己的
`rules-loader` 事故就是证据：`setRulesLoader` 自 `e2be832` 起只有定义没有调用点、
模块从不加载、守卫永远早退，持续数月 —— 而 **lint / typecheck / 安全审计全绿**，
**knip 也没报**（它只看得到那条 import 边），最终是**覆盖率实测**发现的。

**四步协议（顺序不可换）**

1. `knip` 死代码图分析 → 候选清单（**报告制，不是判决制**）
2. 覆盖率 ∩ 图分析 → 区分「真未接线」与「假报」（**两清单不相交是常态**）
3. `git log -S "new Foo"` 考古 → 判断「从没接过线」还是「曾接过后来拔了」
4. 用 T1 的遥测数据投票 → **删掉没人用的**

> **第 4 步的适用范围（2026-09-15 写死，防误用）**：只对「**command / tool 形态的功能**」投票
> —— 只有这两类有计数器。`task-runner` / 双轨 Runtime / `plan-runner` 这三个**子系统**
> **不能**用遥测判定存在性，改用 `knip` 的未接线清单（它给出的 4 条真未接线本身就是存在性证据）。
> **本项不得为此新增计数器**：为「证明某子系统没人用」而新埋点，等于先污染采集口径再去读它。

**落地结果（2026-09-15 实跑，四步走完）**

- **候选 12 → 5 条真未接线 / 7 条假报**。假报根因在**配置而非 knip 本身**：`knip.json` 的
  `ignore` 含 `bin/**`，而 `bin/mipham.ts` 是真实入口且用**动态 `await import()`** 加载依赖
  （如 `:1204` 供 `--dump-config` 用）⇒ 只经它可达的文件一律被误报。这 7 条已**具名**记入守卫，
  免得每次跑 knip 都重新困惑一遍；**不写进 `ignore`** —— 那会让真正的信号从此沉默。
- **第 3 步的判据是「函数名」不是「文件名」**：`git log -S "new Foo"` 在本例 5 条上
  **零命中 = 从没接过线**（而非「曾接过后来拔了」）⇒ 无需兼容层、无需迁移提示。
- **第 4 步遥测投票本批不适用**（见上方适用范围：本批全是 command / tool 之外的**子系统**），
  改用 knip 未接线清单作存在性证据。
- **处置：删 3 留 2**

| 文件                                                     | 处置                 | 理由                                                                                |
| -------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `core/task-runner.ts` + `core/task-runner-tasks.json`    | **删除**             | 已被 `core/task-performance.ts`（LLM 生成代码 → 冻结测试判定 → 分数）取代           |
| `skills/standard/runtime.ts`、`skills/mipham/runtime.ts` | **删除**（含空目录） | 「双轨运行时」自 v0.1.0（`27609bf`）起生产零引用 —— `skills/loader.ts` 从不加载它们 |
| `vajra/leaf/plan-runner.ts`                              | **保留 + 具名豁免**  | Vajra 内核「真叶子」的能力证明；profile-driven live startup 按 M3 决策有意不接      |
| `providers/llm-replay.ts`                                | **保留 + 具名豁免**  | provider-swap 的**测试夹具**（record/replay），不是死代码                           |

- **落点**：`apps/cli/test/integrity/unwired-disposition.test.ts` —— 四条断言：① 判删的路径
  必须不存在（删了又被加回来 ⇒ 红）；② 判留的必须存在**且仍生产零引用**（一旦被接上，
  那条豁免就过期了 ⇒ 红）；③ **生产零引用集合恰好等于保留表**（新冒出的未接线文件不会溜过）；
  ④ 7 条假报确实经 `bin/` 可达。**红绿实跑**：复活被删文件 ⇒ 2 红；把 `plan-runner` 接上 ⇒
  2 红且提示「已被接线，请撤掉豁免」。
- **守卫自己踩过的两个坑（正是它要抓的缺陷类的第 N 次）**：解析器第一版漏认**带真实扩展名**
  的相对说明符（`from '../../core/paths.ts'`）⇒ 活着的模块被判成未接线，即**静默假阴性**，
  被它自己的「集合相等」断言当场抓出；`productionImporters` 起初对每个候选重读全盘，
  O(n²) 撞穿 vitest 的 5s 超时（7381ms → 单遍建表 169ms）。

**估量**：小–中（已落地：3 文件 + 1 JSON + 1 测试删除、1 守卫新增；测试 2547 → 2512，227 文件不变）

---

### [x] T12 · 工具成败位在无头路径上不可读 ✅ 已于 2026-09-16 落地（A / B 两段）

**为什么**：T2 的分数要能被**辩护**，不只是被**报出**。官方 harness 判分看容器最终状态、
**不读**我们的 chunk ⇒ 这条**不卡判分**；它卡的是**归因** —— 跑出 0 分时，分不清「模型没做出来」
与「我们的权限层把工具吃了」。这与基准运行选 `bypassPermissions` 要防的是**同一类污染**。

**现状（2026-09-15 核实）**：成败位**两端都建得好** —— 源头是 `ToolResult.success`（MCP 工具
从 `isError` 派生，`tools/system/mcp.ts:70`），CLI 落盘端是 JSONL 的 `tool/result` 事件带**全量**
`ToolResult`（实测 **381/381 条**都带 `success`）。**中间三条边界各丢一次**：

| #   | 边界                                                                                                            | 后果                                                             | 性质   |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| 1   | `engine.ts` 的 `tool_result` chunk 构造（`process` 与 `continueWithTools` **两处**）—— `StreamChunk` 无承载字段 | 无头路径**分不出**工具成功与失败                                 | **缺** |
| 2   | 投影消息 `ToolResultContent`（无 `is_error`）+ `providers/anthropic.ts`                                         | **模型被告知**每次工具调用都成功了                               | **缺** |
| 3   | `core/session-log.ts` 的 `messageToEvents` 写死 `success: true`                                                 | message→event **伪造**成功（旧格式迁移会把历史里的失败洗成成功） | **假** |

**两条反直觉佐证**：① `~/.mipham/sessions/*.jsonl` 一条都不带，**不是** code path 的问题 ——
是 `daemon/server.ts` 构造 `ContextManager` 时**没传 `log`** ⇒ `context.ts:153` 的 `if (this.log)`
在无头路径恒 false，**daemon 一条 JSONL 都不写**；② REST 出口救不了：`messages` 表**没有 success 列**
（`daemon/database.ts:170`），`GET /api/v1/sessions/:id/messages` 结构上带不出这个位。

**A 段（2026-09-16 落地）**：`StreamChunk.isError`（两份 `types.ts` 同步）→ 两处构造点填
`!result.success` → `session-worker` 映进**已声明、只是从没人填**的 `ServerToolResultMessage.isError`
（`attach-protocol.ts:33`）；`remote-engine` 回程同补 —— 只填出口不填入口，字段出了 WS 就回不来。
**顺带修掉一个更重的缺陷**：`continueWithTools` 那处此前**连展平都没有**、直接发 `result.content`，
而失败结果的 `content` 恰是**空串**（错误在 `error` 里）⇒ **多轮循环里工具失败时，模型收到一个
空 `tool_result`，错误文案整个丢失**（红测实测 `expected '' to contain …`）。

**B 段（2026-09-16 落地）**：`ToolResultContent` 加 `is_error`，`messageToEvents` 读真值而非写死
`true`，`anthropic.ts` 据此传真实 `is_error`。**唯一要拍板的是字段形状，选了「只在失败时出现」** ——
A 段给 `StreamChunk.isError` 选「恒设」的理由在这里**不成立**：它要过 `daemon/database.ts` 的
`messages` 表与旧 JSONL，**历史数据里没有这个字段**，`undefined` 在可预见的将来不可能消除，恒设
只剩代价（成功路径字节全变 + 请求体多一个 `is_error: false`，一次 prompt-cache 前缀抖动）。
**五个改动点**：两份 `types.ts`（双副本逐字节 diff 为空）→ `context.addToolResult`（engine 两条
路径的**唯一投影写点**）→ `agent/sub-agent.ts`（**第二个独立投影写点**）→ `session-log` 读写两侧
→ `anthropic.ts`。**字节级互逆不变量保住** —— 展平式两侧对称、成功侧不写该键。**明确不改**：
`openai-compat.ts`（OpenAI 的 tool 消息结构上无此位）、`session-worker`/`remote-engine`（A 段
已通）、microcompact（`...block` 展开天然保留）、daemon `messages` 表（无该列，结构上带不出）。

**验收（B 段）**：`is_error` 只在失败时出现，成功路径在内存 / JSONL / Anthropic 请求体三处与
改动前**逐字节相同**（用 `'is_error' in block === false` 钉住 —— 只断 `=== false` 抓不到恒设）；
`messageToEvents` 不再伪造成功；投影消息与日志派生**双向一致**（往返用例）。红绿实跑 **7 红 → 全绿**。

**验收（A 段）**：失败的工具调用在 WS 上带 `isError: true`、成功带 `false`；多轮路径的失败结果**不丢**错误文案。

**估量**：A 段小（5 文件 + 5 条测试）；B 段小–中（6 文件 + 7 条测试，契约加性可选字段、不单独发版）

---

## P1 — 决定能不能卖

### [x] T5 · 未接线收口 ✅ 已于 2026-09-15 落地

**为什么**：`apps/cli/src/daemon/server.ts` 的 `getOrCreateEngine` 对同层能力**一个都没接** ——
这是「**两条渲染路径只接一条 = 局部正确全局遗漏**」的**第二次发生**（第一次就是 `rules-loader`）。

> **锚点更正**：原文写 `server.ts:177`，那是**空行**。真正的装配块是 `:178-241`，引擎建在 `:237`
> 的 `getOrCreateEngine` 内。全文件对 engine 只有两次调用（`setSessionId` 与一处 getter）。

> **原文「constitution 一个都没接」是误报，已删**：`grep -rn "align:" apps/cli/src/` **全仓库无人声明**
> `align`，而 `mountConstitution` 只装一个**在 mount 时被查一次**的门 —— 没声明 `align` 就永不生效；
> 真正的原则执行走 `engine.getConstitutionLoader()`（引擎内惰性构造），**一直是活的**。
> ⇒ 不给没接的宪法加豁免行，把错误说法直接删掉。

**落地结果**：缺口**不是同一种东西**，按后果分三档 —— 接线因此也不能一律照抄。

| 档           | 能力                                                    | 不接的后果                                                                                                                                               | 本次                        |
| ------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **必错**     | `setSkills`                                             | `createToolRegistry()` 无参路径照样把 `Skill` 工具挂进注册表，但工具上下文没有 loader ⇒ 那个工具**每次调用都返回错误**（模型被广告了一个永远失败的工具） | ✅ 接                       |
| **静默退化** | `setRulesLoader` / `setHookEngine` / `setAgentRegistry` | 规则永不注入 / hooks 全不跑 / 自定义 agent 解析不到（`?.` 可选链，连警告都没有）                                                                         | ✅ 接                       |
| **反例**     | `setLlm`                                                | **不接反而是对的**：daemon 原本 `llmChat` 回退 registry、provider 回退照常工作                                                                           | ✅ 接（**先修语义**，见下） |

- **新增 `apps/cli/src/daemon/engine-capabilities.ts`** —— daemon 该有的能力集中到**一个**装配点，
  让「再加一个能力忘了接 daemon」变成守卫能咬住的源码差异，而不是靠人记得。`server.ts` 只加
  两行（import + 调用），且调用紧跟 `setSessionId`、在 `engineCache.set` **之前**，保证没有路径
  能拿到半接线的引擎。
- **`setLlm` 的语义缺陷必须先修**（`core/engine.ts`）：生产路径注入的**就是 registry 自己**
  （`index.tsx` → `mountLlm` 是原样 `provide` → `setLlm(vajraContext.get(LLM_KEY)!)`），
  而回退判据写的是「非空即缝」⇒ **CLI 的 provider 回退分支在生产恒不可达，只活在测试里**
  （旧测试构造引擎时不注入缝，走的是生产已不走的那条路径 —— 「验的不是生产那个对象」）。
  判据改为 `this.llm !== this.registry`。**顺序不可颠倒**：先接 daemon 再修语义，会削掉 daemon
  唯一还活着的回退。这条顺序约束已由行为测试钉死（先落步 2 后落步 1 必红）。
- **豁免表（9 条，逐条带理由 + 源码锚点，锚点会漂移所以是断言不是散文）**：`setArtifactServer`
  （TUI 画廊的 localhost 监听器；不接则 `Artifact` 退化成 `file://`，且不在 daemon 进程里**再开一个
  监听面**）· `setAgentViewManager`（唯一消费者是 TUI slash 命令）· `setCrossSessionConfig`
  （**注意不能写成「从来没调用」** —— `process()` 每次开头就跑 `pollCrossSessionInbox()`，
  daemon 一直在跑引擎默认的 fail-closed 策略；真理由是「接上用户那份更宽松策略会在一个没有审批 UI
  的入口扩大入站接受面」）· `setCrsiConfig`（**全仓库零调用点，CLI 侧也一样**，既有缺口另立条目）·
  `setInferenceHookConfig`（**待决策的数据出境面**，见下）· 以及 TUI 侧四个（`setEffort` / `setGoal` /
  `setOnWakeupEnqueued` / `setCrsiConfig`，由 `app.tsx`、`commands.ts` 接线，不在引导路径上）。
- **文件如实登记的三处未修缺陷**（本项只登记，不修）：① `<cwd>/.mipham/settings.json` 的
  `permissions.allow/deny` 到不了 daemon（`workspace-guard` 管的是 cwd，不是工具白名单）；
  ② 工具上下文里的 `cwd` 是 **daemon 根**而非会话 cwd（`engine.ts` 传 `process.cwd()`）；
  ③ **frontmatter 声明的 skill hooks 是死路** —— `SkillDefinition.hooks` 要的是 `handler`
  **函数**（`shared/types.ts:247-251`），YAML 表达不了函数，而 `skills/loader.ts:186` 是裸 cast
  ⇒ 写了 `hooks:` 的 SKILL.md 注册出 `handler: undefined` 的定义，调用时抛错被 `runHooks` 的
  catch 吞掉（注释明写 **fail-open**，不阻断执行）并记失败直到自动禁用。CLI 侧
  （`index.tsx:586-592`）一模一样，**不是 T5 引入**；但本项让这条路径**远程可达**（渠道调用者
  驱动的会话同样过 skills + hooks 装配），故登记。它也是覆盖率里那条唯一未覆盖的语句
  （`engine-capabilities.ts`：语句 97.36%、分支/函数/行 100%）。
- **有意排除、另立条目**：**daemon 至今没有任何系统提示** —— MIPHAM.md / CLAUDE.md / 记忆 /
  skills reminder 一条都到不了 headless 会话。这是最大的洞，但 T5 原文没点名，且装配内联在
  `index.tsx:485-557`，需要先抽出来复用。**记在这里，不静默漏。**
- **核实结论（原文「未核」项）**：凭据解密失败**不会**让 `config.skills` 半填 ——
  `decryptProviderApiKeys` 只碰 `providers`，且在 `skills` 装配完毕之后才跑。

**验收（红绿都实跑记录，不是纸面）**

1. **`T1` 先红后绿**：把回退判据改回 `if (this.llm)` ⇒ 新增的「注入的缝就是 registry」那条必红，
   而「异己缝」那条仍绿；改回 `!== this.registry` 转绿。
2. **`D2` 钉住顺序**：`wireDaemonEngine` 后 provider 回退仍生效（warning + 回退正文 + active 切回默认）。
3. **守卫有施加点**：抽掉 `engine-capabilities.ts` 里任一 `setX(` ⇒ 源码对等守卫红；删掉 `server.ts`
   里 `wireDaemonEngine(` 的调用 ⇒ 「接线入口真的被调用」那条红。两条都实跑后还原。
4. **行为测试有牙**：同时抽掉 `setSkills` / `setRulesLoader` / `setHookEngine` ⇒ daemon 行为测试
   **5 红**（`D1` / `D3` / `D4` / `D6` / `D7`），`D2` / `D5` 不受影响。

**已认下的后果（不静默收窄）**

- **接 `setSkills` 给 daemon 开出一条新的远程可达路径**：`Skill` 工具是 `permission: 'self'`，
  接上后渠道调用者（飞书 / Telegram / 企业微信 / 钉钉）驱动的会话可以拉起本地已装 skill，
  skill 正文进入对话。执行腿仍被权限钳住，但两点不受权限管：`ensureSkillAssets` 在**任何权限检查
  之前**就写文件；`recordSkillUsage` 对 `~/.mipham/skill-usage.json` 是无锁读改写（并发会话丢更新，
  良性）。`context: fork` 还会带来每次调用一次额外 LLM 调用。**要收紧就该加一张 daemon 侧 skill
  白名单，另立条目。**
- **接 `setHookEngine` 让 `<cwd>/.mipham/settings.json` 的 hooks 在 daemon 会话里执行**（会 spawn
  shell）。与 CLI 同构，但 daemon 会话可被远程渠道驱动 —— 属已认下的后果。
- **记忆化表活到进程结束**：改 `~/.mipham/settings.json` 或项目 agents 要**重启 daemon** 才生效。
  规则 loader 是**唯一不记忆化**的例外（`load()` 同步幂等，共享一只会让长命 daemon 永远看不见
  会话期间新增的规则）。要 invalidation 另立条目。
- **守卫的残洞（照实说）**：正则只认 `x.setY(` 形态，动态装配（`applySetters(engine, CAPS)`）看不见。
  缓解是「接线文件清单被声明且断言可达」—— 新加一个动态机制会让守卫**变红**而不是静默变绿；
  docblock 里写明：动态接线必须同时扩展这条守卫。

**落点**：`apps/cli/src/daemon/engine-capabilities.ts`（新增，装配只此一处）+ `server.ts` 两行 ·
守卫 `test/integrity/daemon-capability-parity.test.ts` · 行为测试 `test/daemon/engine-capabilities.test.ts`

**验收**：源码对等（守卫：14 个注入点全集 − 具名豁免 = daemon 实接集，两向相等、陈旧豁免为红）
**且**行为对等（真跑 `engine.process()`：`Skill` 工具真能拉起 skill、规则真注入、hooks 真注册、
agents 真解析、provider 回退仍活着）。

**估量**：中（已落地；测试 2533 → 2547，225 → 227 文件）

---

### [ ] T6 · 自研模型端点上线

**为什么**：端点不起，产品实质是「**多模型客户端**」—— 护城河建在别人的 API 上。

**落点**：`apps/cli/src/providers/registry.ts` 的 mipham 路由（门面已就位）

**依赖**：`models/` 仓库侧交付

**估量**：大（跨仓库）

---

### [ ] T7 · 企业版最小集：SSO + 审计日志 + 策略下发

**为什么**：没有这三样，进不了企业采购流程。

**已有雏形（从它长出去，不要另起）**

- `src/core/permission.ts` 的 `permissionRestrictions`（org 级强制降级，请求被禁模式时
  fail-closed）→ 长成**策略下发**
- `src/core/session-log.ts`（append-only JSONL，「model-visible means logged」）
  → 长成**审计日志导出**

**落点**：`src/core/permission.ts`、`src/core/session-log.ts`、新增 SSO 接入层

**估量**：大

---

### [ ] T8 · 桌面 App 签名公证打包

**为什么**：这是**已知怎么做**的活 —— 流程在 MiphamAI4S / MiphamAI4T 上已跑通过，
`infrastructure/` 已有 icns 与 cask。

**落点**：`infrastructure/`、`scripts/build-desktop.sh`（见 `CLAUDE.md` §十六）

**注意**：⚠️ `.app` 公证后，**dmg 还需再公证一次**（历史踩坑）

**估量**：中

---

## P2 — 决定能不能规模化

| 编号    | 项                      | 性质                 | 说明                                               |
| ------- | ----------------------- | -------------------- | -------------------------------------------------- |
| **T9**  | 支持 / SLA / 定价       | **商业决策，非工程** | 没有它进不了企业采购流程                           |
| **T10** | 合规认证（SOC2 之类）   | 商业 + 工程          | 周期长，宜早启动                                   |
| **T11** | 开放 MCP / skill 注册表 | 工程 + 生态          | 让**别人**为你写扩展 —— 这是唯一能追生态差距的路径 |

> T11 的战略意义：竞品的护城河不是模型，是**生态**（海量 MCP server、plugin、社区技能、
> 教程与存量问答）。这个差距**不是靠加功能追的**，只能靠让别人在你的平台上生产。

---

## 附录 · 已报未修的技术债（低成本，可顺手清）

按「精准修改」原则此前只报告、未自行改动：

- [x] **D1** · 根 `README.md` 非存在的 flag —— `--model` / `--provider`（原 `:64/:68/:72`）在
      `apps/cli/bin/mipham.ts` 里根本不存在（实测该文件里这两个串**零命中**；入口只认
      `--version`/`-v`/`-V`、`--help`/`-h`、`--dump-config`、`--safe-mode`、`--resume`）。
      **2026-09-22 裁定：改文档抹掉**（岔路口 #3 → 已决议）。Run 段改写为真实接口 ——
      env key + `config.yml` 的 `defaultProvider`/`defaultModel`，或启动后 `Ctrl+P` / `/pick`
      两级选择器 / `/switch <provider> <model>`；并显式写明「本 CLI 不解析这两个 flag」。
      **flag 本身仍未实现** ⇒ 已立为独立 feature：见下方 **D11**。
- [x] **D2** · 根 `README.md` 其余陈旧数字 —— **2026-09-22 全清**（逐条实测，非估算）：
      `:56` `→ 0.2.2` → `@miphamai/cli v0.83.0`（入口打印的正是 `PACKAGE_NAME` + `PACKAGE_VERSION`）；
      `:95` `/help (40+)` → **137**（`registry.set('/…')` 实测 137 个、全唯一）；
      `:108` `version: '0.2.0'` → `'0.83.0'`（`config/defaults.ts:12` 取的就是 `PACKAGE_VERSION`）；
      `:111` `permission: auto` → `default`（`defaults.ts:15`），并就地标注「`auto` 现在是分类器档，
      **不是**旧义『让工具自行决定』」—— 这行本身就是 `fc5afd3a` 事故的输入，属安全相关而非单纯陈旧；
      `:131` 「10 家 / 45+」→ **12 家 / 48**（**快照**：当时的模型条目数，此后随注册表演进）。
      **同批实测出 D2 原单未列的 6 处**：模型表**整行缺 ollama**；OpenAI 缺 `GPT-5.3 Codex`；
      MiphamAI 缺 `OM V5 Apex` 且 status 标 `Upcoming` 而真值是 `active`（`shared/types.ts` 的
      `status?: 'active' | 'upcoming'`）；Google 的 Context 写 `128K–2M` 实为 **1M**（三个模型全是
      `1000000`）；MiphamAI 的 Context 写 `200K–1M` 实为 **16K–200K**（上限 `200000`）；
      export 表缺 `MIPHAM_API_KEY`。另把 MiniMax 一行拆成「国内 / 国际」两行 —— 原表 10 行对 12 家，
      拆后**行数与 provider 数 1:1**。`:18` 技能数（28 = 22+6）与 `:17`/`:83` 工具数（31）**实测本就
      正确**、未动。
      **病根同批收口**：这几个数此前**没有任何守卫** —— 工具总数被守着、技能清单被守着，夹在中间的
      provider/model 数正好落在缝里。已在 `test/integrity/tool-reference-integrity.test.ts` 补第六段
      `提供商与模型总数声明完整性`（真源 `DEFAULT_PROVIDERS`，扫描面与本文件其余段**共用**同一份
      `liveDocs`）。**负控两条实跑**：把 `:138` 的 provider 数从 12 改成 10 ⇒ 红，故障信息点名该行
      并写出真实值；把模型数从 48 改成 45 ⇒ 同样红；两侧还原后 sha256 与改动前逐字相符。
      （**引文此处刻意不逐字抄故障信息** —— 那串里带着「N 家提供商 / N 个模型」的旧值，而 ROADMAP
      本身就是扫描面内的活文档：逐字抄等于把两个**错的**计数写进一份被守卫的文档里。**这条坑是本
      守卫上线后第一个咬到的对象，且咬的是它自己的变更记录。**）
- [x] **D3** · `~/.mipham` 在 `src` 里 **8 处各自独立定义** —— **已收口（2.90.0）**。实测**条目低报了一个
      数量级**：`git diff` 的 `-` 侧共 **89** 个 `'.mipham'` 字面量、散布 **52** 个文件（用户级
      `join(homedir(), '.mipham', …)` / 项目内 `join(cwd, '.mipham', …)`，两级的根都没人守）。
      **先订正条目、再动手**：落点仍是条目所指的 `src/core/paths.ts` —— 新增 `miphamHome(...segments)`
      （用户级，62 个调用点），项目内**沿用该文件已有的惯用法** `join(<dir>, MIPHAM_DIR, …)`
      （40 处 / 12 个文件），**不造第三个 helper**。改后字面量在 `src/` 里只剩 `shared/constants.ts`
      的两处导出：`MIPHAM_DIR`（真源）与 `USER_CONFIG_DIR`（D4 待删的第三个名字）。
      **一处非显然的边界**：`miphamHome()` 必须是**调用时**求值 —— `config/loader.ts` 的 `MIPHAM_HOME`
      是**模块作用域**捕获的，`test/telemetry/index.test.ts` 靠 `vi.mock('node:os')` + `vi.hoisted`
      **抢在 import 之前**装 mock 才拦得住它；故该函数的文档注释里写明了它**不得**改成在别处预先算好
      再传进来。**顺带发现、只提不删**：`commands/environment.ts` 往生成的 shell 脚本里写
      `export MIPHAM_HOME="${home}/.mipham"`，全仓**零读取者** —— 同一目录名的第四个名字，按约定留档不改。
      测试数**不变**（255 文件 / 3,051 测试、0 失败）—— 纯重构不加测试，既有测试全绿即语义未变的验证；
      typecheck 与 eslint 均 0 告警。
- [x] **D4** · `USER_CONFIG_DIR` 零消费者（`src/shared/constants.ts`）—— **已删（2.91.0）**。先复核
      **零消费者**（不照条目信）：全仓命中只有三类 —— 定义处本身、两份**历史档**（`docs/claude-md-history.md`
      的 2.37.7 逐字存档，**那一条正是当初报告此债的原文**；`docs/superpowers/plans/2026-05-31-*.md`
      的时点计划）、以及 D3 那笔的变更记录 ⇒ **零 import 点**；两份 barrel 又都是 `export * from './constants'`
      ⇒ 删定义即足、无需改 barrel。两侧同删（D5 的 byte 档要求镜像，只删一侧会红）：删后两份 sha256 仍
      逐字相等、`git diff --numstat` 两侧各为 `0 1`（只删不增）。**负控实跑**：把那行**只加回副本侧**
      ⇒ byte 档按预期变红，失败信息点名「`constants.ts: 第 542 行`」。**过程事故（已回退）**：负控的还原步
      写了 `cd ..`，从 `apps/cli` 只退到 `apps/`，于是 `cp` 打到不存在的路径、紧接的 `rm` 又把备份删掉
      ⇒ 副本侧一度仍停在变异体上；已按「删掉那一行」修回，并与负控前的 sha256 **逐字核对相符**
      （这是修复成立的判据，不是「看着对」）。**测试数不变**（255 文件 / 3,051 测试、0 失败 —— 删的是
      零消费者的死导出，既有测试全绿即「无消费方」这一前提的第二重证明）。
- [x] **D5** · 两个 `constants.ts` 已分叉且无守卫 —— **已收口（2.89.0）**。实测**前半句不成立**：
      两侧均 562 行、sha256 逐字相同 ⇒ 真缺口是**覆盖面**，整族 5 对里只有 `types.ts` 有人守，
      而模型快照与 provider 端点常量的全部价值就在值上。新守卫
      `test/integrity/shared-vendor-parity.test.ts` 把整族收进一张表、**按形状分三档**（逐字节 3 对 /
      只差头部块注释 1 对 / 成员集合 1 对转既有守卫 + 一条「它是例外」的锚），四条断言全部实跑负控、
      各红一个用例、还原后 sha256 逐字相符。
- [x] **D6** · 国内站 `src/app/try/page.tsx` 是**死代码** —— `/try` 已被 redirect 到
      `/mipham-code`（`next.config.mjs`），永不渲染；且内容严重过时（`config.yaml` 应为
      `config.yml`；`--provider`/`--model` flag 不存在；`providers:` 写成 map 而真实 schema 是数组）。
      **已收口 —— 但收在另一个仓库里**：本条目登记在 `mipham-code` 的背景下，而对象属于
      `websites` 子模块（**全路径** `websites/domestic/apps/onemipham.com/src/app/try/page.tsx`），
      故修复走的是 `websites` 自己的分支/PR（**PR #21** squash，`42c45de` → `f35735e`，提交信息即
      `chore(domestic): 删掉 /try 死代码页 —— 308 重定向早已接管（ROADMAP D6）`），
      整个 `src/app/try/` 目录删除、185 行。**关键判据**：`next.config.mjs` 里那条 **308 带 `permanent: true`**
      早已接管该路径 ⇒ 删文件**不会**让它变 404（若只写 redirect 而没有永久语义，这次删除才会把页面打成
      硬 404 —— 顺序检查是这一步的前提，不是附带说明）。
      **删前逐条复核过时内容**（对象已删，下面是 `git show f35735e^:…` 的实测读数）：
      ① `config.yaml` 出现 **3** 次、`config.yml` **0** 次 ⇒ 文件名确实写错（真源是 `config.yml`）；
      ② `providers:` 在 `:154` 下**缩进成 map**（`deepseek:` 再嵌一层），而真实 schema 是数组；
      ③ 页面 `:87` 确实调了 `mipham --provider … --model …`，而 CLI 入口 `apps/cli/bin/mipham.ts`
      对这两个串**零命中**（正对照：`--resume` 在同一文件 5 次）⇒ **「不存在」的主语是 CLI、不是页面**
      —— 页面把它们当真实接口宣传，正是这次要删的理由。故不是「删一个也许还有用的页面」。
      **⚠️ 未部署** —— 生产行为不变（308 早已在），部署需单独授权。
      **口径**：跨仓库收口不改变本条目的归属，但要写清「修复落在哪个仓库 + 全路径」，否则后来者
      会在 `mipham-code` 的 `apps/` 里找一个从不存在的页面。
- [x] **D7** · **上下键历史导航** —— **已收口（2.92.0）**。原文「仍是 open bug …… `navigateHistory`
      纯函数已正确，问题在**接线层**」**猜对了方向、指错了对象**：纯函数确实是对的，而接线层的
      **基本路径也是对的** —— 新写的接线层测试（`test/ui/input-history-wiring.test.ts`；此前 `test/ui/`
      17 个文件**无一条**渲染 `InputBar`，本测试按键走 ink 的 raw 序列）里，「提交后 ↑ 调回」
      「↑ 后 ↓ 回空草稿」「空历史 ↑ 无操作」**三条本来就绿** ⇒ 原文那个全称断言**复现不出来**。
      **真缺口在另一条路径上**：`submittedHistory` 是 `InputBar` 的**局部 state**（`input.tsx:305`），
      而 `app.tsx` 有三条路径把 `InputBar` **整个卸载**（`pickerOpen ? <ModelPicker/> : <Box>…<InputBar/>…</Box>`
      —— 三元两支的**组件类型不同** ⇒ React 卸载而非复用；`if (apiKeyPrompt)` 整棵早退；Ctrl+G）
      ⇒ **每卸载一次历史清零**（「开一次模型选择器，刚才敲的就没了」）。修法：把历史**提到 `app.tsx`**
      （`inputHistory` state），`InputBar` 收 `history` + `onHistoryAppend` 两个**必填** prop；
      两个游标 ref（`historyIndexRef` / `savedDraftRef`）**留在组件内** —— 它们是浏览游标，
      随卸载重置才是对的。**负控实跑**：按旧形状把历史变异回组件内（3 处锚点各命中 1 次）
      ⇒ **只有卸载那条红**、正对照（同样重渲染但不卸载）仍绿 ⇒ 该用例是真判据不是仪式；
      还原后 sha256 与变异前**逐字相符**。**边界（只提不改）**：草稿 `value` 仍住组件内、
      切 picker 一样丢；历史**不从会话日志回填**，↑ 只翻本次挂载以来敲过的条目。
      测试 3,051 → **3,056**（255 → 256 文件，0 失败）。

- [ ] **D8** · `ui/input.tsx` 的 **ghost-text 自动补全**（`core/autocomplete.ts`）—— 已核实**接线是真的**，
      不是本仓库反复栽的「有定义、无施加点」：`app.tsx:1206-1210` 真传 config、`registry.ts:122`
      的 `req.model || activeModelId` 让 `model: ''` 正确回退、过期结果经 `isStale()` 返回 null 后
      还有 `if (completion)` 兜底、`MiphamTextInput:242` 显式让位 Tab。**三条缺口**：
      ① **代价** —— `AUTOCOMPLETE_MAX_CONTEXT` 限的是**条数**不是 token（`recent` 逐字取
      `m.content`、无任何截断，编程会话里 6 条可以是上万 token 上行），且**取消不掉**
      （`Llm.chat` 无 AbortSignal、`isStale()` 只在**整条流消费完之后**才判）⇒ 每次 >400ms 的
      停顿都买一个完整 completion。② **接线层零测试** —— `test/ui/` 11 个文件无一条碰 ghost text
      （Tab 接受 / 防抖取消 / `suggestionReqId` 失效三条路径全靠人眼），而纯函数与
      `requestSuggestion` 本身覆盖得**不差**。③ **注释漂移** —— `:314-315` 写「三处共用
      `clearSuggestion`」，Tab 接受路径 `:398-404` 是**第四处**、只 `setSuggestion(null)`
      （不 bump reqId、不清定时器）；当前不可达（有建议显示 ⇒ 上次请求已结束），
      但「接受后继续续写」一加就是洞。
      **2026-09-25 复核（只更新位置，结论不变）**：上面「接线是真的」**再核一次仍成立** ——
      `app.tsx:1351-1353` 传 `llm` / `recentMessages` / `autocompleteEnabled`、`registry.ts:122`
      的 `req.model || activeModelId`、`input.tsx:250` 把 Tab 让回去、`autocomplete.ts:62` 仍是
      **流消费完之后**才判 `isStale()`。漂的只是**指针**（D7 把历史提到 `app.tsx` 时改过 `InputBar`
      的 props，整段后移）：③ 的注释现在是 `:326-327`，那个绕开点当时在 `:414`（另外三处
      `clearSuggestion()` 在 `:399` / `:443` / `:502`）—— **③ 已于 2026-09-25 收口，见下**。
      **另**：`:546`（当时是 `:541`）每次输入也直接 `setSuggestion(null)`，但那处随即
      `++suggestionReqIdRef` 并重排定时器 ⇒ 不缺环，**不算第四个绕开点**。
      **2026-09-25 ②③ 收口（同一批）：**
      ② 补接线层测试 `test/ui/input-autocomplete-wiring.test.ts`（此前 `test/ui/` 一条都没碰过
      ghost text）—— 5 格：Tab 接受（核心）+ 防抖只发一次且发的是最后一次文本 + 陈旧结果不上屏，
      外加两条对照（不按 Tab 时建议只上屏、不进正文；慢补全不被打断时确实能上屏）。
      **观测点选在 `onSubmit` 而不是 `lastFrame()`**：建议渲染在与正文**同一个 row Box** 里
      （`input.tsx:576`），屏幕上 `> hello world` 既可能是「正文已含建议」也可能是「正文 + 幽灵」，
      字符串断言分不出这两件事，提交出去的值分得出。**负控实跑**：同时变异三处接线（Tab 只取正文 /
      不加 `++reqId` / 不清定时器）⇒ **恰好对应的三格红、两格对照仍绿**；还原后 `sha256` 与变异前
      逐字相符（`6815535c…`），三个锚点逐个回读确认在位。
      ③ 接受路径改走 `clearSuggestion()`（原为手写 `setSuggestion(null)`），`:326` 的「三处共用」
      随之改成四处，并注明 `onChange` 那处内联版**故意不共用**（它要的是把 reqId 推成新的）。
      **这一处今天不可达**（有建议显示 ⇒ 上次请求已结束、定时器已烧掉），故 ③ **没有新测试** ——
      它消掉的是「接受后继续续写」一加上就会现形的洞，不是今天的 bug。
      **① 仍未收口（代价），且两半要分开定：** (a) `AUTOCOMPLETE_MAX_CONTEXT` 限的是条数不是 token，
      给每条 `content` 截断要先定一个数（截多少、按字符还是按 token）；(b) 「取消不掉」要真取消，
      得有人**提前 break 消费循环**，而 `openai-compat.ts` 的读循环**没有 `finally { reader.cancel() }`**
      （该文件唯一的 `finally` 管的是 idle 定时器）⇒ 提前 break 会留下未取消的 response body，
      等于拿「白烧 token」换「泄漏连接」。故 (b) 的前置是**在 provider 侧补流清理**，而那是
      engine / daemon / 子代理共用的路径，不顺手做 ⇒ 留待裁决。

- [x] **D9** · `scripts/smoke-daemon.sh` 的三处遗留 —— **已收口（2026-09-25，未发布）**。
      原文三处**逐条核实成立**（① 就绪检查确为管道式；② 两个守卫分支在 CI 里零执行；
      ③ 超时路径不 `kill`），处置见下。**注**：原文一处口径，守卫分支是**两条**（不是
      「这三条」），用例是**三个**（多一个正对照）。
      ① **惯用法已统一** —— 就绪检查改为捕获式（与删除闸同形），并把注释里那句
      「两处惯用法不统一」的欠账划掉。两处细节不同是**刻意**的：`2>&1` 而非 teardown 的
      `2>/dev/null`（这里 status 自己崩掉就是发现本身，且崩溃栈不含匹配文本，仍会落到 FAIL
      臂）；`|| true` 防 `set -e` 抢在 FAIL 那句之前中止。**真产物两条调用复核**（默认 PATH
      与 `RUN_PATH=/usr/bin:/bin`）均绿 —— stub 只能验控制流，这一步必须用真产物。
      ② **守卫分支补了负向用例**：新 fixture `apps/cli/test/fixtures/smoke-daemon-stub-cli/`
      （stub CLI：全部契约就是 `daemon status` 要问的那一个问题「pid 文件在不在」，编译进
      `$WORK` 后**自报自身路径**，用例据此找到 `mktemp` 目录 —— 不必新增 `WORK` 注入缝）、
      `scripts/smoke-daemon-guards.sh`（三个用例：`ok` 正对照 + `survives-stop` + `never-ready`）、
      `ci.yml` 加一步。**首次真实执行的读数**：两条守卫分支**本身是对的** —— 退出码、告警、
      以及「WARN 保留 `$WORK` / FAIL 删掉 `$WORK`」这个**刻意的不对称**都与注释所述一致
      ⇒ 缺的从来不是正确性，是「从没有人跑过」。**同批自查抓到一条「不会失败的检查」**：
      第一版把「告警里带 pid」断言成**整段输出**含 `4242`，而 stub 的 `status` 本来就打印
      `PID: 4242` ⇒ 那条断言与告警无关、恒绿；收紧到**告警那一行**后先红后绿。
      **另**：`$line）` / `$RC，` 会被 bash 当成变量名（UTF-8 下 `isalnum` 认全角标点），
      必须写 `${line}` —— `set -u` 下当场中止。
      ③ **分两半、方向不同** —— `startDetachedDaemon` 的超时分支是**真缺陷，已修**：放弃前
      **再探一次** `getStatus()`（截止时间是预测不是事实，压在线上就绪的 daemon 不该被杀），
      确实没起来则 `SIGKILL` 回收它自己起的子进程 —— 留着它，下一次 `daemon start` 会在
      already-running 分支上把那个进程**当成功报回来**（`getStatus()` 只是 pid 文件 +
      `kill(pid,0)`）；`kill()` 返回假时**不提**「已回收」（子进程可能自己退了，那是另一回事）。
      脚本侧**刻意不做硬杀**：`daemon stop` 刚被无视 2 秒，此时对可能正在写库的进程补
      SIGKILL 恰是这一支存在的理由所反对的那件事 ⇒ 改为把 **pid 印进告警**（从刚捕获的
      status 里解析，非数字则打 `?`），泄漏于是**可执行**：谁占着 `127.0.0.1:45671` 一目了然，
      而 `$WORK` 仍按原设计保留。（**残留如实记**：脚本侧的泄漏仍由人回收；它不静默 ——
      下一次跑到同一个端口会**响亮**失败，而占位者的 pid 已被上一条告警印出。）
      **边界**：守卫用例跑的是这个脚本的**控制流**，不是真 daemon（真产物的 happy path 由
      `ci.yml` 那两条覆盖）。测试 3,449 → **3,451**（同文件 +2，0 失败）。
- [x] **D10** · `~/.mipham/daemon.log` 无轮转 —— **已收口（2026-09-25，未发布）**。
      三条主张逐条核实成立，但**其中一条口径要订正**：① `startDetachedDaemon` 以追加方式
      `openSync(logPath,'a')` 并把该 fd 当 stdout/stderr ✓；② 「`daemon/logger.ts` 逐事件写一行
      JSON」✓ **但它写的是 stdout/stderr**，文件只是那个 fd 的重定向 —— 「谁在写这个文件」的答案
      是两处，且只有一处知道文件存在（`logger.ts` 里没有路径这个概念）；③ 全仓库无轮转 / 截断 /
      上限 ✓（零命中已复核）。
      **触发条件裁定成立**：`~/.mipham/permission-audit.jsonl` 是同目录下**第二个无上限的追加型
      sink**（`recordClassifierRuling` 只 append、`readClassifierRulings` 整份读回，同样没有任何
      上限）。**处置：只给 daemon.log 做轮转，台账刻意不动** —— 审计台账静默丢行是**策略决定**
      （与「日志只留尾巴」不同，台账的价值在全集），不是顺手能做的机械修复；且实测其体量
      （11.6 KB / 约两周）离磁盘告警还差好几个数量级。**同批看到的第三类（记下未动）**：
      `sessions/*.jsonl` 与 `workflows/`（**5,820** 个 run 目录 / 50 MB，而单个 `journal.jsonl`
      只有 **75 B** —— 体积几乎全在目录与块的固定开销上）属「文件只增不回收」，修它要先定保留
      策略（留多久、谁删），那是产品决定，不在这里顺手做。
      **修法与理由**：`rotateLogIfLarge(logPath)` 在 `startDetachedDaemon` 里 `mkdirSync` 之后、
      `openSync` **之前**调用 —— 那是唯一「没有写者」的时刻（已经在跑的在前面就早退了，pid 文件
      已消失）；**改名而不是截断**：读侧只要尾巴（`tailLog` 默认 800 B），但这个场景真正要留的
      恰恰是**上一代** —— 一个反复起不来的 daemon，前一次留下的就是全部线索；只留一代（`renameSync`
      覆盖目标）⇒ 上限恒为 2 × `MAX_LOG_BYTES`（5 MiB），**永远没有 `.2`**。轮转失败只打印不抛
      （日志转不动就拒绝启动，是把慢风险换成即时故障）；大小读不出来（首次启动的 ENOENT）直接返回，
      那是每次首启的正常路径。
      **判据**：`test/daemon/launch.test.ts` 28 测试（+5）—— 三条直调（未达上限内容一字不动 /
      **恰好等于上限即轮转**，把「≥」这个边界钉住 / 文件不存在不抛也不建）+ 两条走真
      `startDetachedDaemon` 的正负对照（正例断言 `.1` 的大小与首 4 字节、新文件 0 字节、无 `.2`；
      负例断言未超限时既不轮转也不截断）。**两个方向都做了变异**：删掉调用点 ⇒ **只有正例红**
      （接线因此是真的）；去掉大小判断 ⇒ **只有两条负例红**（负例不是空转）；两次还原都过了
      sha256 逐字校验。**同批自查抓到一条空转的负例**：`LOG()` 手写 join 漏了 `.mipham` 一层
      ⇒ 负例那句 `existsSync('.1') === false` **恒真**（代码压根没看那个文件），是**正例红掉才
      暴露的** —— 只有负例会一直绿；改为一律从 `miphamHome()` 派生。测试 3,451 → **3,456**。
- [x] **D11** · **（自 D1 转来）实现 `--model` / `--provider` 顶层 flag** —— **已收口（2026-09-25，未发布）**。
      **触发条件成立，且是实测撞出来的**，比条目预期的强：不是「将来 CI / 脚本可能需要」，而是
      **两个已发布调用方现在就在递** —— `infrastructure/vscode/extension.js` 的 `buildFlags()` 与
      `infrastructure/jetbrains/src/main/kotlin/com/miphamai/plugin/MiphamAction.kt` 的 `buildCommand()`
      都从插件设置里拼
      `mipham --provider <id> --model <id>`；网站 `/code/docs` 页也把 `mipham --model claude-sonnet-4-6`
      当示例印着（`apps/web/src/app/code/docs/page.tsx:15`）—— 在那之前它是**假主张**，本次由实现补上落点。
      实测那条命令的回答是 `Unknown command: mipham deepseek`（rc=1，**CLI 根本起不来**）：怪的是 provider
      的**值** —— `--provider` 不在 `VALUE_FLAGS` 里 ⇒ 值落进位置参数 ⇒ 撞上 `detectUnknownArgument` 的
      未知命令分支，而那个分支跑在所有 flag 解析**之前**（所以只加解析、不补两张表，等于什么都没修）。
      **条目三条主张逐条核实：两条成立、一条要订正。** ① 入口确实没有解析器、逐个探（`--version`/`--help`/
      `--dump-config`/`--safe-mode` 走 `includes`）✓；② 要做的事、以及「必须先定清楚」的两问，问得对 ✓；
      **③ 「文档与代码一致（都说没有）」只对根 `README.md` 成立** —— 它是按**一份**文档核的，而另外**两处
      表面**（两个 IDE 插件、网站 docs 页）一直在说「有」。这不是措辞问题：D1 据此判定「功能从未存在，
      故改文档抹掉」，而**真实用户路径上一直有人在递这两个参数**。教训与本仓库既有的
      「广告的能力要有落点」同族，只是这次广告贴在**别人的仓库里**（插件 + 网站）。
      **接线其实早就铺好了**：`RunOptions` 一路都有 `provider?`/`model?`，`index.tsx:453` 也早写着
      `const defaultProvider = options.provider || config.defaultProvider` —— 这是同一形态的**第三次**
      （继 `--resume`、`--permission`：「声明了却没有调用点」）。故修法三处：两张表各补两个名字、入口解析后
      转发（与 `--resume` 共用同一条缺值判据）、帮助里印出来。
      **两问的答案**：① 与 `--dump-config` **不相交** —— 后者先于 `runApp` 打印 vajra profile 树
      （`vajra/compose/dump.ts` 只输出 `id\tkind\tconfig`，不含 provider/model）并 `exit(0)`；
      ② 与 config 的覆盖关系**由既有 `||` 的次序定死：flag 赢** —— 这一行本次**没动**，动的只是「谁把值递进去」。
      **值域裁定：不设闭集合校验**（与 `--permission` 有意不同）—— provider 可以是用户自定义的
      （`config/loader.ts` 的 `mergeProviders` 会整只收下不认识的那条），静态白名单必然误拒合法输入；
      值原样转发，不认识的 id 由 `ProviderRegistry.getActive()` 抛 `Provider "X" not registered` 点名，
      与同一个值来自 `config.yml` 时**逐字一致**（一扇门一套语义）。`--model` 不隐含 provider（归属不由 CLI 猜）。
      **测试**：`arg-validation` 补两条行为用例（含插件那条命令原样放行、错序、值后的野命令仍被抓）；
      新建 `test/commands/provider-model-flags.test.ts`（**源码级** —— 成功路径会进 Ink，无 TTY 直接抛
      raw mode，同 `--resume`/`--permission` 先例，文件头写明它证明不了什么）。**三条负控各咬中目标、
      还原均过 sha256 逐字校验**：撤 `VALUE_FLAGS` ⇒ 3 红（含事故回归位）；倒 `||` ⇒ 1 红；撤转发 ⇒ 1 红。
      另有真跑三格：无 TTY 的正对照（不带 flag 同样 raw mode ⇒ 那条命令确实进了 app）、缺值仍拒、
      `--provder` 仍被拦（闸没被拆）。
      **同批记下的两件事**：① 根 `README.md` 那段 flag 清单**早已漂了**（列 5 个，`--permission` 落地后
      没跟，且无守卫扫它）⇒ 本次**改成不枚举**、指向 `mipham --help`，而不是刷新第二份清单；
      ② 网站 `/code/docs` 的示例配置仍带着陈旧值 ⇒ 另立 **D13**。测试 3,456 → **3,468**。
- [ ] **D12** · **`mipham update` 的安装本身仍不是原子换手** —— 2026-09-22 事故后的修法是
      「**装前快照 + 装后自证 + 失败回滚**」（见 `CLAUDE.md` 2.94.0）；**2.94.1 把另一半补上**
      （Ctrl-C）：回滚代码跑在 CLI 进程里，而终端 Ctrl-C 把 SIGINT 发给**整个前台进程组**
      ⇒ CLI 与 npm 一起死、catch 从不执行。现由两道守卫收口 —— `detached: true`（npm 自成
      进程组）+ `blockSigintDuringInstall()`（CLI 挂 SIGINT 守位、`finally` 撤）。**于是
      「可捕获的终止」这条路已经走完**（SIGTERM 与 SIGINT 都有回滚兜着），
      但挡不住**不可捕获的终止**：`SIGKILL`、
      断电、容器被杀 ⇒ 快照还在、回滚那一步没机会跑，用户手上仍是「一棵半截树 + 一份
      `~/.mipham/backups/cli-*`（唯一可用的旧版）」，需要**手工**还原。
      要做的话：装进一个 **staging prefix**（`npm install -g --prefix <tmp>`），校验通过后
      再对真正的 `lib/node_modules/@miphamai/cli` + `bin/mipham` 做**两次 rename** —— rename
      在同文件系统内是原子的，于是「任何一个瞬间」都有一份能跑的 CLI；代价是 `--prefix`
      装出来的 launcher 路径与全局前缀不同，需要额外改写（或只搬包目录、launcher 用
      `ln -sfn` 的原子换名）。**触发**：再次出现「更新后一个 CLI 都没有」的实例（含
      SIGKILL / 断电形态），或 D12 之外还想让更新可被 `pgrep` 之外的东西中断时
      **2026-09-25 复核（未实施 —— 裁定：缓）**。三条保护主张逐条对上了代码：`snapshotInstall`
      / `verifyInstalledVersion`（两道门：包内 `package.json` 版本 + launcher **实跑** `--version`）/
      `restoreInstall` 的「快照—自证—回滚」链、npm 自成进程组的 `detached: true`、
      `blockSigintDuringInstall()` 都在。**触发条件未出现**：全仓库没有任何「更新后一个 CLI 都没有」
      的新实例记录。
      **⚠️ 本条目那句代价被两次离线实测证伪**（原文：「`--prefix` 装出来的 launcher 路径与全局前缀不同，
      需要额外改写」）：① 真装一份 tarball 到 `npm install -g --prefix <tmp>`，落下的 launcher 是
      `bin/<name> -> ../lib/node_modules/<pkg>/bin/cli.js` —— **相对符号链接，与真 prefix 下逐字同形**
      ⇒ 只搬包目录需要**零**改写；② 装出来的树是**自包含**的（7/7 声明依赖都在 `<pkgDir>/node_modules`，
      共 86 项）⇒「只搬包目录」是完整动作，不是省略。**残余代价只剩换手序列本身**：staging prefix 必须是
      `pkgDir` 的**兄弟**（同文件系统才保证 rename 原子）、两次 rename 之间有微秒级「目标名不存在」窗口、
      `restoreInstall` 仍是外网。
      **残余风险边界也被实测收窄**：`execSync` 在**直接子进程被杀**时**抛**（`status=null` /
      `signal=SIGKILL`，plain 与 `detached: true` 皆然），正常退出则不抛 ⇒ 只要 CLI 进程活着，用**任何**
      信号杀 npm（含 `-9`）都会走到 `performUpdate` 的 catch / 回滚。真正无解的只剩三种：断电 / 机器崩、
      把 CLI 与 npm 一起杀、CLI 先死而 npm 随后失败。⚠️ **诚实边界**：实测的是 **`execSync` 的语义**
      （用真 npm 跑一次更新再中途杀它**没做**）。
      **裁定：缓做** —— 它不是活缺陷（触发未发生），且改动落在**曾经把用户搞砖的那条路径**上：一次做错的
      期望伤害面是「每个用户的下一次更新」。先把真实代价订正下来，供下一个会话按真价决策（本条目自身那句
      代价即一例「债务条目的主张不是事实」—— 判据是离线可测的，没有理由留着一句假价）。
      同一次复核里发现的活缺陷另立 **D14**（就在下方，已收口）。
- [x] **D13** · **（D11 同批发现）网站 `/code/docs` 页的示例配置仍是陈旧值** ——
      `apps/web/src/app/code/docs/page.tsx` 里那份 `~/.mipham/config.yml` 样例写着 `version: "0.2.2"`
      与 `permission: auto`。后者与 D1 在根 `README.md` 修掉的那行**同形状**：`auto` 合法（在 `ALL_MODES` 里），
      但它是**分类器档**，不是旧义「让工具自行决定」—— 那一行本身就是一次事故的输入，故属**安全相关**
      而非单纯陈旧。**为什么单独立项**：它在 `apps/web`，而 `tool-reference-integrity` 的扫描面是
      根目录 `*.md`（除 `CHANGELOG.md`/`PRODUCT.md`）+ `apps/cli/README.md` + VS Code 的
      `README.md`/`package.json` —— **不含**任何 `.tsx`，也不含 `infrastructure/jetbrains/`
      （D11 那两个调用方正是从这道缝里漏出去的）。同页其余内容**实测无误**：`/help`、`/model`、`/switch`、
      `/clear`、`/exit` 五个命令各 1 命中 `registry.set`，`--model` 示例本次已为真。
      **触发**：下次改网站文案时顺带，或 `version` 再跳一档时
      **已收口（2026-09-25，未部署）** —— 四句主张逐条实测，**全中**：① `version: "0.2.2"` 陈旧
      （当前 **0.85.5**）；② `permission: auto` 确在 `ALL_MODES` 内、但语义是**分类器档**
      （`permission.ts` 的只读工具注释写明 `auto` 让只读工具过分类器）⇒ 比产品默认
      `permission: 'default'`（`config/defaults.ts:15`）**更宽**，正是 D1 在 README 修掉的同形状；
      ③ `claude-sonnet-4-6` 确为已注册模型（`shared/constants.ts:45`）；④ **无任何守卫扫
      `apps/web/**`** —— `SCAN_ROOTS = [<cli>/src, <cli>/bin]`（`tool-reference-integrity.test.ts:54`），
      故 `.tsx` 里的样例配置全在扫描面之外（该文件 `SCANNED_EXTENSIONS` 含 `.tsx`，但只作用于那两个
      root —— D13 那句「不含任何 `.tsx`」**准确**）。
      **修法不是把 `0.2.2` 改成 `0.85.5`** —— 硬编码就是它会烂的原因，而**同一页第 14 行**早已用
      `${PACKAGE_NAME}` 派生。改 `version: "${PACKAGE_VERSION}"`（同页补 import），此后再跳版本
      **不会**再烂；`permission: auto` → `permission: default`（对齐产品默认）。两处同页，
      `PACKAGE_NAME` 的先例就是判据。
      **诚实边界**：**未部署** —— 本笔只让**仓库里**的页面正确；线上 `/code/docs` 何时更新是另一步
      （部署需单独授权；且 `version` 现由构建期常量派生 ⇒ 部署那一刻才定格）。
      **另记（未处置，待裁定）**：D13 指出的那道缝是**真的** —— `apps/web/**` 不在任何守卫的扫描面内。
      是否扩面是独立决定（把 `apps/web` 加进 `SCAN_ROOTS` 会引入新的假红面），不在本笔内自行决定。
- [x] **D14** · **（D12 复核时发现的活缺陷）`resolveInstallPaths` 的 Windows 分支差一层** ——
      **已收口（2026-09-25，未发布）**。
      **缺陷**：npm 在 win32 下把全局包装进 `<prefix>/node_modules`（**没有 `lib` 这一层**），bin shim
      落在 **`<prefix>` 本身**；而旧代码把 Unix 的**四层 `..`** 用在两个平台上 ⇒ Windows 下 prefix
      多退一层，`launcher` 指向 `<prefix 的父目录>/mipham.cmd` —— 那个文件**永远不存在** ⇒
      `verifyInstalledVersion` 的第二道门（**实跑 launcher**）**必失败** ⇒ **每一次 `mipham update` 都把
      刚装好的新版回滚掉**：Windows 用户**永远升不上去，而且每次都被告诉「失败」**。同一处还**跳过了
      对照物检查** —— 正是该分支自己的文档写着「绝不猜」的那一格（这条分支返回的是**算出来**的路径，
      没有任何东西证明它是 node prefix）。
      **依据（npm 自带源码，离线读）**：`lib/npm.js` 的 `globalDir`
      （`process.platform !== 'win32' ? <prefix>/lib/node_modules : <prefix>/node_modules`）；
      `bin-links/lib/bin-target.js` 的全局分支（`dirname(prefix)/bin` 对 **`prefix` 本身**）；
      `@npmcli/config/lib/index.js` 的 `loadGlobalPrefix`。
      **为什么它活到现在**：平台分支直接读 `process.platform`，**Windows 那半在开发机与 CI（都是 Unix）
      上永远跑不到** —— 夹具也是 Unix 形状。**而 Windows 是出货目标不是假想**：`install.ps1` 装的是
      `%LOCALAPPDATA%\mipham\bin\mipham.exe` 并加 PATH，`release.yml` 在 `windows-latest` 上构建
      `bun-windows-x64`。
      **修**：`resolveInstallPaths(fromDir?, platform = process.platform)` —— `platform` 只为**测试可注入**
      （这正是让「跑不到的那半」在任何机器上都能**真跑**的落点）；win32 走三层 `..`、launcher 落
      `<prefix>/mipham.cmd`，且两个分支都过对照物（Unix `<prefix>/bin/npm`、Windows `<prefix>/npm.cmd`）。
      **测试**：`test/shared/update-safety.test.ts` 新增 Windows 形状夹具 + 5 条用例（含端到端
      「装好 ⇒ 自证过 ⇒ 不回滚」，以及单独钉住「多退一层」那条算术）。**两条负控各咬中目标、还原均过
      sha256 逐字校验**：把 Windows 分支改回四层 `..` 并撤掉对照物 ⇒ **恰好 5 条新用例红**、18 条旧用例
      全绿（缺陷复现）；把 Unix 分支改成三层 ⇒ 9 条红**全是 Unix 形状**、5 条 Windows 用例仍绿。
      **诚实边界**：**没有真 Windows 机器参与** —— 夹具里的 `mipham.cmd` 是带 shebang 的普通文件，
      验的是**路径形状**，不是 cmd 语义。测试 3,468 → **3,473**（296 文件不变）。
- [ ] **D15** · **（2026-09-25 审公开面数字时发现）i18n 的 vendored 复制对没有守卫，且 shared 副本已陈旧分叉**。
      **已收口的那半**：`web.features.slash_commands` 在**两份副本 × 两种语言**里都写「85 Slash Commands」/
      「85 个 Slash 命令」，而实测 `getCommandNames().length === 137`（`ui/commands.ts:5890`，
      `bun -e` 真跑）⇒ **本仓库自己的产品页 `mipham.ai/code`**（`apps/web`）宣传的命令数是陈旧的。
      已改 `85 → 137`（4 个文件：`packages/shared/src/i18n/locales/{en-US,zh-CN}.json` +
      `apps/cli/src/i18n-core/locales/{en-US,zh-CN}.json`；`docs/slash-commands-audit.md` 的标题是
      **带日期的快照**（检测日期 2026-07-26 / v0.7.8），按「历史不可改」**不动**）。
      **未处置的那半（本条目）**：这一对副本**不在** `shared-vendor-parity.test.ts` 的族表里 ——
      该守卫守的是 `packages/shared/src/*` ↔ `apps/cli/src/shared/*`，而 i18n 住在
      `packages/shared/src/i18n/locales/` ↔ `apps/cli/src/i18n-core/locales/`（CLI 侧由 `ui/commands.ts:82`、
      `core/engine.ts:54` 等 5 个文件 import）。实测两者**已经分叉**：共有 **586** 键里 **8 个值不同**
      （如 `commands.stats.tokens`：shared 至今硬编码 `200,000`，CLI 早已改成 `{max}` 以跟上 1M/500K 自适应窗口）、
      CLI 侧独有 **245** 键、shared 侧独有 **10** 键。**两者不是包含关系** ⇒ 无论朝哪边整体同步都会打掉
      对方的东西（shared 独有的 6 个 `web.install_page.*` 正被 `apps/web` 安装页读着）。
      **边界（别把它读成线上缺陷）**：`apps/web` 只读 `web.*` 命名空间（`grep -o "t('[a-z_]*"` 实测），
      故那 8 个分歧键与 245 个 CLI-only 键**都不上屏**，是**死副本的陈旧**、不是活主张。
      **为什么它逃过了守卫**：与 D13 同一形状 —— 「刻意重复、代价由守卫付」这条账**只在那 5 对上收过**，
      这一对从来没进过族表；而 `packages/shared/**` 同样不在 `tool-reference-integrity.test.ts` 的
      `SCAN_ROOTS`（= `<cli>/src` + `<cli>/bin`）里 ⇒ **两套守卫都够不着它**。
      **修与不修都要先定档位**：加进族表就得先定形状（既非逐字节、也非只差头注释，且两边各自多键 ⇒
      像 `types.ts` 那样只能按成员集合比），而按成员比**比不出这 8 个值漂移** ⇒ 真正的判据是
      「共有键的值必须相等」。**但那条更严的判据也抓不到本笔的「85」** —— 两份当时写的是**同一个错值**
      （这正是它至今没被任何人抓到的原因），值相等的守卫只会全绿：**它证明的是两份一致，不是两份对**。
      要抓「85」需要的是**真值判据**（页面上的数字 vs `getCommandNames()`），而 `web.*` 目前**一条都没有**。
      扩面与否、以及要不要补真值判据，留待裁定。

---

## 建议的推进顺序

```
第 1 步（并行；三者互为前提，构成闭环）
  T3a ✅ 覆盖率门禁  →  T1 ✅ 遥测（CLI 侧）  →  T4 ✅ 死代码盘点
     已落地         →  已埋点（T1b ✅ 接收端已上线）  →  已落地（12 候选 → 5 真未接线，删 3 留 2）

第 2 步（最高杠杆；决策已拍板）
  T12 工具成败位（T2 的仪器前置）  →  T2 公开基准
      A 段 ✅ 已落地（2026-09-16）  →  ✅ 已拍板（2026-09-16）：Terminal-Bench
      B 段 ✅ 已落地（同日结项）        10 题 × k=1 · 发布模型 deepseek-v4-pro

第 3 步（补齐质量证据）
  T3b ✅ ESLint type-checked  →  T3c ✅ 变异测试（**7 文件全接**）  →  T5 ✅ 未接线收口
     已落地（只开 no-floating-promises 一条，error 级）      已落地（基线 7.05%，待补断言）   已落地（第 3 步走完）

第 4 步（商业化）
  T6 模型端点 ∥ T8 桌面打包  →  T7 企业版
```

**`T3a`、`T1`（CLI 侧）、`T3b`、`T1b`（接收端上线）、`T3c`（首批）、`T5` 与 `T4` 已于 2026-09-15 落地**（见上）。
第 1 步（闭环三件）**已整条走完**：埋点（`T1`）→ 出口（`T1b`）→ 据此清账（`T4`）。
**第 2 步 `T2` 的岔路口 #2 已于 2026-09-16 关闭**（基准 = **Terminal-Bench**），**第 3 步已走完**；
其仪器前置 **`T12` 已于 2026-09-16 结项**（A 段修「无头路径读不到」、B 段修「模型被告知每次调用都成功」）；
**起手的前半（路线 A+ 里的 daemon 自启修复）亦已落地并推送**（Plan A，2.50.0）—— 剩下的只有 Harbor 适配器。

**关于 `T4` 第 4 步的时间窗 —— 结论是「本批用不上」**：遥测聚合按接收日分区，本意是要等数据
积累出可投票的量；但 T4 实跑后 5 条真未接线**全部是 command / tool 之外的子系统**，本就落在
上方「适用范围」的豁免里，故改用 knip 未接线清单判定 —— **第 4 步没有阻塞这条线**。数据窗仍
值得积累，留给**将来重跑**：那时若浮出 command / tool 形态的未接线文件，才轮到遥测投票。

**下一件未阻塞的**：~~`T3c` 第二批（`crsi-sandbox.ts`）待单独决策~~ → **✅ 已于 2026-09-15 收掉。**
而那一条「待决策」理由本身是**错的**：`runTests()` 根本没有测试覆盖，它的变异体全落 `NoCoverage`
（Stryker 对 no-coverage 变异体**什么都不跑**），所以既不存在「每次踩到跑一遍整套套件」，也不存在
「成本与其余 6 个文件不同量级」—— 实测并进来后**总数 +423、总耗时反而略降**。详见上方「范围收窄」。

**当前执行序（2026-09-15 定；2026-09-16 更新）**：`T3b` ✅ → `T1b` ✅ → `T3c` ✅（**7 文件全接**）→ `T5` ✅ → **`T4` ✅** → `T12` ✅ → **`T2`**（岔路口 #2 已关闭、Plan A 已落地，剩 Harbor 适配器）——
与上方按步分组不同：`T1b`（接收端）提到 `T2` 之前（它让 T1 的数据真正有出口）。

---

## 待决策的岔路口（阻塞项）

| #   | 决策                                                                                            | 阻塞                  |
| --- | ----------------------------------------------------------------------------------------------- | --------------------- |
| 4   | daemon 会话要不要接 **PreInference DLP**（`setInferenceHookConfig`）—— 接了就是**对话正文出境** | 无（T5 已按豁免放行） |

### 已决议（保留记录，供回访）

| 日期       | 决策                                                  | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 影响项 |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-09-15 | 遥测上报到**自建端点**还是**第三方**                  | **自建端点** —— 数据不出自有域名，第三方 SDK 的 DPA / 数据出境条款不适用；代价是端点属 T1 的新增待建项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | T1     |
| 2026-09-15 | 基准 daemon 的**权限策略**（T2 起手时暴露）           | **`bypassPermissions`**，只经**进程级 env**（`MIPHAM_DAEMON_PERMISSION`）给，配专用 daemon + 临时工作区 + 跑完即杀。**另两档产出的读数是关于我们自己权限过滤器的报告，却会挂上模型名字**：`default` 下 Bash/Write/Edit 是 `permission: 'ask'`（`tools/exec/bash.ts:317`）而 daemon 无审批层 ⇒ 引擎把拒绝当 `tool_result` 回给模型（`engine.ts:1075-1088`），工具一次都不执行；`acceptEdits` 只对 Bash 放行白名单**且**要求命令不含任何 shell 元字符（`;` `&` \| `>` `<` 反引号 `$`，`permission.ts:22`）⇒ 带管道的命令一条都过不去。**行为实证**（Run 2 对照：同一 daemon、同一模型、同一条带管道命令）：`default` ⇒ `Tool "Bash" requires approval under "default" mode.`，模型随后明确拒绝猜值；`bypassPermissions` ⇒ 真输出大写 md5，与独立复核逐字相同。**降级边界**：mode 只被 `permissionRestrictions` 降（`clampMode`，`permission-config.ts:37-51`），而它只来自工作区 `loadConfig(cwd)` ⇒ **基准工作区必须干净**。日常 `mipham daemon start` 仍走 `default`，`resolveDaemonPermission()` 兜底不动。发布物须写明 mode 与该行 env | T2     |
| 2026-09-16 | 基准选 **Terminal-Bench** 还是 **SWE-bench Verified** | **Terminal-Bench** —— 更贴近 agent 真实形态（ROADMAP 原记的判断），用户 2026-09-16 上午明确。**同批定下三件**：① 发布模型 = **`deepseek-v4-pro`**（第三方，**产品判断** —— 真实基准走成熟模型，成绩才可解释、可复现；**与自家模型摸底解耦**，§1.4 是顺带摸底、不是选型依据）；② 开工规模 = **10 题 × k=1**（循「先 spike 再全量」惯例，避免管线隐病一次烧掉全量）；③ 接入路线 = **A+**（修 daemon 自启 + Harbor 适配器直驱 daemon REST API）—— 其中 daemon 自启那半已于同日落地（Plan A，2.50.0）。设计与仪器：`docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md`（spike 已验通官方现役数据集 **66 题** / 预置镜像 / oracle 基线 1.000）                                                                                                                                                                                                                                                                                                                                                                                    | T2     |

| 2026-09-22 | 根 `README.md` 的 `--model`/`--provider`：**改文档**还是**实现 flag**（岔路口 #3） | **改文档抹掉** —— 实测这两个串在 `bin/mipham.ts` 里**零命中**（入口只认 `--version`/`-v`/`-V`、`--help`/`-h`、`--dump-config`、`--safe-mode`、`--resume`），该功能**从未存在**。不选「实现」，理由是**人用场景已有覆盖**（启动后 `Ctrl+P` / `/pick` 两级选择器、`/switch <provider> <model>`），而非交互式选型**目前没有真实需求** —— 为一个假设需求加参数解析，正撞「不添加未被要求的可配置性」。文档已改写为真实接口并明写「本 CLI 不解析这两个 flag」；实现本身转为 **D11**，由需求触发。 | D1 / D11 |

> 编号稳定不复用：#1 / **#2** / **#3** 已关闭（#3 = `README` 的 `--model`/`--provider`，2026-09-22 裁定改文档），后续新增岔路口从 **#5** 起编号。

---

## 变更记录

| 日期       | 变更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-15 | 初版建立：P0 4 项 / P1 3 项 / P2 3 项 + 技术债 7 项 + 3 个待决策岔路口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-09-15 | **T3a 落地**：`vitest.config.ts` 增 `coverage.thresholds`（行 54 / 语句 54 / 函数 59 / 分支 44，取 CI 条件实测值回退一档）+ CI test job 接上 `--coverage` 执行路径；红绿三步验证通过。基线行改为 CI 条件值并附本地/CI 对照表                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-09-15 | **修正 T3a 的事实错误**（实测后）：覆盖率 `include` 其实**已写**（在 `package.json` 脚本里，不在 config 文件），初版说成「没有配置/只报已加载文件」是错的；真实缺口是**无阈值** + **CI 不跑 `--coverage`**。同时把基线从 2026-09-14 的旧值更新为 2026-09-15 实测值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-09-15 | **岔路口 #1 决议**：T1 遥测上报端点定为**自建**（数据不出自有域名，第三方 DPA / 数据出境条款不适用；代价是端点属 T1 新增待建项）。T1 前置由「⚠️ 待决策」改为「✅ 已定」，阻塞解除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-09-15 | **T1（CLI 侧）标记落地 + 基线覆盖率行改本地读数**：`T1` 由 `[ ]` 改为 `[x]`（接收端另立 T1b），推进顺序图与「下一件」结论同步更新为 `T3b`；基线表覆盖率行由 **CI 条件值**改为**本地（有 API key）实测值**（行 56.76% / 分支 47.8% / 函数 62.35% / 语句 56.54%，T1 落地后复测；分母 +284 即 `src/telemetry/` 进分母），并注明**阈值仍取 CI 条件值** —— 该行换基准不等于阈值换基准                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-09-15 | **T3b 落地**：`T3b` 由 `[ ]` 改为 `[x]`；基线表 ESLint 行由「❌ 缺」改为「✅ 已有」，测试行 2492 → 2494（221 → 222 文件），文档数字守卫行 5 组 → 6 组（新增 `lint-rules.test.ts`）；T3b 条目下补「实测」段（既有告警实为 14 条 + 5 个解析错，非估量的「几百条」；规则必须落 `error`，因根 lint 脚本无 `--max-warnings`；`allowDefaultProject` 让规则对 tsconfig 外文件重新生效并浮出一个真悬挂 Promise）；执行序标记 `T3b` ✅，下一件收敛到 **`T1b`**。**注意：本轮同时删掉了原文「下一件是 `T3b`」的结论**，改指向执行序                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-09-15 | **T1b 上线 + 客户端 v2 撤帧 + 文档回填**：`T1b` 由 `[ ]` 改为 `[x]`（含落点、2026-09-15 实机验收三条独立证据、以及**须按集团 §二 走例外申请**的如实偏离 —— 该端点实际 TLS 1.2+1.3，因握手版本在主机 2 由该地址的**默认 server** 决定，版本于 ClientHello 定死、早于 SNI 回调，官方 wontfix 到 1.29.2）。客户端按 `schemaVersion: 2` **从线上撤掉 `stackFrames`**（服务端从来不存，发了只是白送 ~3 KB/次与一个隐私面；顺序不可颠倒 —— 服务端先上线接受 v1；v1 已发布二进制收不回，故 `framesDiscarded` 汇聚路径长期保留），契约测试相应改为**双向钉**（本批产物 `=== 0`、手写 v1 体 `=== 2`）。**同批写死与 `T4` 的分工**：`T4` 第 4 步限定为「command / tool 形态的功能」，`task-runner` / 双轨 Runtime / `plan-runner` 改用 knip 未接线清单判定，**本批不加计数器**（防止拿一个弱信号去做删代码的判决）。文档回填：`docs/telemetry.md` 新增「What the receiver keeps」与「Why there are no stack frames」、`apps/telemetry/README.md` 与 `CLAUDE.md` 同步；测试 2523 → 2525（本批 +2：telemetry +1 / integrity +1，224 文件不变；接收端 179 用例不变）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-09-15 | **T3c 落地（首批 6 文件）**：`T3c` 由 `[ ]` 改为 `[x]`；基线表变异测试行由「无 / ❌ 缺」改为**实跑基线 8.02%**（130 killed / 1311 survived / 180 no-coverage，1621 变异体 · 6 文件 · 8m55s，退出码 0）；测试行 2525 → 2533（224 → 225 文件），文档数字守卫行 6 组 → 7 组（新增 `mutation-wiring.test.ts`）。**范围收窄**：`crsi-sandbox.ts` 延后第二批（其 `runTests()` 会在临时 worktree 跑整套套件，每个踩到的变异体都要付全量），延后表在守卫里明写（`DEFERRED_TO_BATCH_2`）。**产物**：`stryker.config.json` + `mutate` 脚本 + 两个 devDependency（零生产依赖）+ `.gitignore`（`.stryker-tmp/`、`reports/`）+ `eslint.config.js`（忽略 `**/.stryker-tmp/**` —— 沙箱**不保证被清掉**，实测遗留 3 个目录 / 269 MB，而 ESLint 不读 `.gitignore`，`pnpm lint` 因此凭空报 **1809 个 error**；已手动清掉遗留副本）。**本轮实测纠正了两条会撒谎的读数**：① `vitest.related`（默认 true）把干跑从 225 个文件收到 38 个 —— 必须留着（关掉会把真开 git worktree 的 `crsi-sandbox.test.ts` 拉回每一轮），且对动态变异体已逐文件核对为无损（其余 187 个文件里只 2 个提到这 6 个模块，且都未 import）；② **静态变异体（213 个 = 13% 变异体、约 88% 耗时）没有 `coveredBy`，跑的是本次相关集的全部测试 ⇒ 其死活取决于整套 `mutate` 范围**（单跑 `crsi-managed-rules.ts` 时 41.18% → 35.29%），故趋势观察必须固定同一份清单；另测出 ±1 抖动（同配置 4 跑：3 次 5 killed / 1 次 6 killed，摊到 1621 上是 0.06 点，不影响基线）。**解析缺口**：不设 `break`（同 T3a：阈值只升不降；将来与守卫里 `break === null` 断言同改）。**红绿验证**：`break: 99` ⇒ 退出码 1；`mutate` 指向不存在路径 ⇒ 守卫红。**前置**：必须在 `apps/cli` 下跑（继承 31 个假红陷阱）、Xcode git 闸。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-09-15 | **T5 落地（未接线收口）**：`T5` 由 `[ ]` 改为 `[x]`。**锚点更正**：原文 `server.ts:177` 是空行，真装配块是 `:178-241`、引擎建在 `:237` 的 `getOrCreateEngine`。**删掉原文「constitution 一个都没接」**（误报：`align:` 全仓库无人声明，而 `mountConstitution` 只在 mount 时查一次那个门；真正的原则执行走 `engine.getConstitutionLoader()`，一直活着）。**缺陷分类**：`setSkills` 缺是**必错**（`Skill` 工具被挂进注册表但上下文无 loader ⇒ 每次调用都返回错误）；`setRulesLoader`/`setHookEngine`/`setAgentRegistry` 缺是**静默退化**；`setLlm` 是**反例** —— 不接反而是对的，故顺序不可颠倒：**先修语义再对等**。**`setLlm` 语义修复**：生产路径注入的正是 registry 自己（`index.tsx` → `mountLlm` 原样 `provide`），而回退判据写「非空即缝」⇒ **CLI 的 provider 回退在生产恒不可达、只活在测试里**（旧测试不注入缝，走的是生产已不走的那条路径 —— 「验的不是生产那个对象」的又一例）；判据改为 `this.llm !== this.registry`。**落点**：新增 `src/daemon/engine-capabilities.ts` 把装配收成一个点 + `server.ts` 两行（调用在 `engineCache.set` 之前，没有路径能拿到半接线的引擎）；守卫 `test/integrity/daemon-capability-parity.test.ts`（14 个注入点全集 − 9 条具名豁免 = daemon 实接集，两向相等、陈旧豁免为红、每条豁免带理由与**源码锚点**）；行为测试 `test/daemon/engine-capabilities.test.ts`（真跑 `process()`：Skill 真拉起、规则真注入、hooks 真注册、agents 真解析、回退仍活）。**豁免表里三条不是「设计如此」就是「另立条目」**：`setCrossSessionConfig` 不能写成「从来没调用」（`process()` 每次开头就跑 `pollCrossSessionInbox()`，daemon 一直在跑引擎默认的 fail-closed 策略，真理由是接上用户那份更宽松策略会在无审批 UI 的入口扩大入站面）；`setCrsiConfig` 全仓库零调用点（CLI 也一样）；`setInferenceHookConfig` 是**待决策的数据出境面**，已立为岔路口 **#4**。**红绿实跑**：判据改回 `if (this.llm)` ⇒ 新测试必红、改回转绿；抽掉 `setSkills`/`setRulesLoader`/`setHookEngine` ⇒ daemon 行为测试 **5 红**（`D1`/`D3`/`D4`/`D6`/`D7`）而 `D2`/`D5` 不受影响；删掉 `server.ts` 的 `wireDaemonEngine(` 调用 ⇒ 守卫红。**文档单位更正**：基线表「文档数字守卫」行原写 `test/integrity/` **7 组**，这个单位**复现不出来**（它是「tool-ref 的 5 个 describe + 每加一个文件 +1」，telemetry-contract 的 6 个 describe 从未计入），按「不许猜一个数」改为**按文件数**的可复现表述（现 5 个守卫文件）。**登记不修**：`<cwd>/.mipham/settings.json` 的 `permissions.allow/deny` 到不了 daemon；工具上下文的 `cwd` 是 daemon 根而非会话 cwd。**有意排除**：daemon 至今无任何系统提示（MIPHAM.md / CLAUDE.md / 记忆 / skills reminder 一条都到不了 headless 会话）—— 另立条目，不静默漏。**已认下**：接 `setSkills` 开出一条渠道调用者可触发的 skill 执行路径（`ensureSkillAssets` 在任何权限检查之前写文件；`recordSkillUsage` 无锁读改写），接 hooks 让项目 `settings.json` 的 hooks 在 daemon 会话里 spawn shell，记忆化表活到进程结束（改配置要重启 daemon）。测试 2533 → 2547（225 → 227 文件）。 |
| 2026-09-15 | **T4 落地（死代码 / 价值盘点）**：`T4` 由 `[ ]` 改为 `[x]`。四步协议（knip → 覆盖率 ∩ → `git log -S` 考古 → 遥测投票）走完一次，**12 个候选 → 5 条真未接线 / 7 条假报**。**假报根因在配置而非 knip 本身**：`knip.json` 的 `ignore` 含 `bin/**`，而 `bin/mipham.ts` 是真实入口且用**动态 `await import()`** 加载依赖（如 `:1204` 供 `--dump-config`）⇒ 只经它可达的文件一律被误报；7 条已**具名**记入守卫（**不写进 `ignore`** —— 那会让真信号沉默，本仓库已为宽 `ignore` 付过一次学费）。**第 3 步的判据是「函数名」不是「文件名」**（`git log -S "new Foo"`），本例 5 条**零命中 = 从没接过线**（不是「曾接过后来拔了」）⇒ 无需兼容层。**第 4 步遥测投票本批不适用**并已回填说明：5 条全是 command / tool 之外的**子系统**，本就落在 T1b 时写死的「适用范围」豁免里 ⇒ 改用 knip 未接线清单判定，**第 4 步没有阻塞这条线**（数据窗留给将来重跑）。**处置：删 3 留 2** —— 删 `core/task-runner.ts` + `core/task-runner-tasks.json`（已被 `core/task-performance.ts` 取代）、`skills/standard/runtime.ts` + `skills/mipham/runtime.ts`（「双轨运行时」自 v0.1.0 `27609bf` 起生产零引用，`loader.ts` 从不加载，空目录一并删）、`test/core/task-runner.test.ts`；留 `vajra/leaf/plan-runner.ts`（Vajra「真叶子」的能力证明，按 M3 决策有意不接）与 `providers/llm-replay.ts`（provider-swap 的**测试夹具**，不是死代码），各带具名理由。**落点** `apps/cli/test/integrity/unwired-disposition.test.ts`：① 判删的必须不存在；② 判留的必须存在**且仍生产零引用**（被接上 ⇒ 豁免过期 ⇒ 红）；③ **生产零引用集合恰等于保留表**（新冒出的未接线文件不会溜过）；④ 7 条假报确实经 `bin/` 可达。**红绿实跑**：复活被删文件 ⇒ 2 红；接上 `plan-runner` ⇒ 2 红且提示「已被接线，请撤掉豁免」。**守卫自身两坑（正是它要抓的缺陷类）**：解析器漏认**带真实扩展名**的说明符（`from '../../core/paths.ts'`）⇒ 活模块被判未接线（静默假阴性），被自己的「集合相等」断言当场抓出；`productionImporters` 起初 O(n²) 重读全盘撞穿 5s 超时（7381ms → 单遍建表 169ms）。**同批回填**：`CLAUDE.md` 2547 → 2512（`core` 1011 → 996、`tools` 339 → 313、`integrity` 39 → 45）、`skills/` 树标签与「双轨运行时」散文、`ROADMAP` 基线表与执行序。删除 5 文件 / 新增 1 守卫文件，测试 2547 → 2512（227 文件不变）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-09-15 | **T3c 第二批落地（范围 7 文件全接）+ 一次证伪自己的对照实验**：`crsi-sandbox.ts` 接进 `mutate`（`DEFERRED_TO_BATCH_2` 清空为 `[]` —— 保留空数组是因为它值在**形状**不在内容：下次真要延后谁，加一项即被守卫可见地记下）。**基线 7.05%**（144 killed / 1507 survived / 393 no-coverage，2044 变异体 · 7 文件 · 8m26s · 退出码 0）。**当初延后的理由被实测证伪**：`runTests()` 的唯一生产调用点 `crsi-modify.ts:92` 在 `crsi-modify.test.ts` 里被 **6 处** `vi.spyOn(sandbox,'runTests')` 整个 mock 掉，`crsi-sandbox.test.ts` 提到它的次数是 **0** ⇒ 其方法体（`:360`–`:425`）的变异体**全落 `NoCoverage`**，而 Stryker 对 no-coverage 变异体**什么都不跑** ⇒「每个踩到该路径的变异体都要付一次全量」里**一个都不存在**；实测总数 **+423**、no-coverage **+213**、**总耗时反降**（8m55s → 8m26s）。**对照实验（本轮最有价值的产出，也是花了 8 分钟才敢下的结论）**：拿**完全相同**的 6 文件范围复跑 ⇒ **137 killed / 8.45%**，而批次一记录的是 **130 / 8.02%** ⇒ **同一配置 killed 差 7 个（0.43 个点）**，误差集中在 `crsi-producer.ts`（55–64）与 `permission-config.ts`（7–9）。据此**推翻两条既有/将写的结论**：① 原「±1 抖动、摊到 1621 上是 0.06 个点、对基线无实质影响」是在**单文件**上量的，**外推到整批低了 7 倍** ⇒ 补两条禁令（单文件百分比不可当精确值读、整批 <0.5 点差异不可解释）；② 我原本准备写进文档的「加文件 ⇒ 静态变异体相关集变化 ⇒ −5」被**直接证伪**（复跑比原值还高）⇒ **在两个各自带 ±7 噪声的读数之间做减法，减出来的不是效应量，是噪声的差**。**方法学更正**：`reports/mutation/mutation.json` **不能**用于跨运行 diff —— 变异体 `id` 按 `mutate` 清单顺序全局递增，中间插一个文件会把其后所有文件的 id 整体推移（首次按 id 比对只匹配上 700/1621 却"成功"吐出 58 个翻转，**全是假的**）；改用位置键虽能匹配回 1621，但会把同位置同名变异体折叠。⇒ **三方并列的逐文件表才是可信来源。** 文档同批回填：`ROADMAP` 基线表 / 执行序 / 「下一件未阻塞」/ 读数纪律两条 / 「范围收窄」全段改写、`CLAUDE.md` 2.45.0 → 2.46.0。**测试数与文件数不变**（本次只动配置与守卫注释，未增删测试）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-09-15 | **T2 起手：daemon 权限策略决议 + Run 2 行为实证**。T2 起手先验「无头路径能不能跑基准」，答案是**不能** —— 由此挖出并修掉 `session-worker` 在 `stop` 上的 `break`（见 `33074f3`：那个缺陷让无头路径**一个工具都执行不了**）。本轮定第二件事：**`bypassPermissions`**，只经进程级 env 给，配专用 daemon + 临时工作区 + 跑完即杀。**理由不是方便，是读数归属** —— `default` 下 Bash 必被拒（无审批层），`acceptEdits` 下带管道的命令全被我们自己的元字符闸挡掉，两者产出的都是**关于我们权限过滤器的报告**。**Run 2 = 该策略的验收，跑的是对照而非单跑**（单跑证明不了任何事：模型完全可能压根不碰 Bash 而用 Read 答了）。同一条带管道命令：`default` ⇒ `Tool "Bash" requires approval under "default" mode.`，模型随后拒绝猜值；`bypassPermissions` ⇒ 真输出 `18227FA8CF436E99801BE973288959BE`，与独立复核逐字相同。**顺带核实两条**：① T5 登记的「工具上下文 cwd 是 daemon 根而非会话 cwd」**实测坐实**（`pwd` 回 `/private/tmp/probeA` 而非 `.../work`；相对路径命令因此静默返回 `(no output)`，管道退出码取末段 `tr` 故仍为 0）；② **`ServerToolResultMessage.isError` 是零生产者的协议字段**（`attach-protocol.ts:33` 声明、`session-worker.ts:325-333` 从不设），而引擎在 chunk 边界就把成败位并进了 `content`（`engine.ts:704`）⇒ **无头路径上第三方基准驱动分不出工具成功与失败** —— 与 `stopReason` 恒为 `end_turn` 是同一类盲区、第二次发生，对 T2 直接承重（待立项）。**无代码变更**（仅文档；探针在 `/tmp`，不进仓库）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-09-16 | **T12 立项（工具成败位）+ A 段落地**：经核实这**不是「缺一个字段」，是成败位在三条边界上各丢一次、且性质不同**。**两端都建得好**：源头是 `ToolResult.success`（MCP 工具从 `isError` 派生），CLI 落盘端是 JSONL 的 `tool/result` 事件带**全量** `ToolResult`（实测 **381/381 条**都带 `success`）。**三条边界**：① `engine.ts` 两处 `tool_result` 构造 —— `StreamChunk` 无承载字段（**缺**）；② 投影消息 `ToolResultContent` 无 `is_error` + `providers/anthropic.ts` ⇒ **模型被告知每次工具调用都成功了**（**缺**）；③ `session-log.ts` 的 `messageToEvents` 写死 `success: true` ⇒ message→event **伪造**成功，旧格式迁移会把历史里的失败洗成成功（**假** —— 比前两条重，前两条是读不到，它是写下一个错的值）。**两条反直觉佐证**：`~/.mipham/sessions/*.jsonl` 一条都不带**不是** code path 的问题，是 `daemon/server.ts` 构造 `ContextManager` 时**没传 `log`** ⇒ `context.ts:153` 的 `if (this.log)` 在无头路径恒 false、daemon **一条 JSONL 都不写**；REST 也救不了 —— `messages` 表**没有 success 列**，`GET /api/v1/sessions/:id/messages` 结构上带不出这个位。**A 段（本轮）**：`StreamChunk.isError`（两份 `types.ts` 同步）→ 两处构造点填 `!result.success` → `session-worker` 映进**已声明、只是从没人填**的 `ServerToolResultMessage.isError`；`remote-engine` 回程同补（只填出口不填入口 ⇒ 字段出了 WS 就回不来，接远端 daemon 的 CLI 依旧失明）。**顺带修掉一个更重的缺陷**：`continueWithTools` 那处此前**连展平都没有**、直接发 `result.content`，而失败结果的 `content` 恰是**空串**（错误在 `error` 里）⇒ **多轮循环里工具失败时模型收到一个空 `tool_result`，错误文案整个丢失**（红测实测 `expected '' to contain …`）。**先补测试再修**：5 条新用例（轮 1 失败标 `true` / 成功标 `false` / 多轮失败既标 `true` 又不丢文案 / WS 出口 `true` / 成功 `false`），红绿实跑 **5 红 → 全绿**。**编号更正**：原提议 `T9` 实为**已占用** —— P2 段的 `T9/T10/T11` 是**表格行不是标题**，先前只 grep 了 `### [ ]` 标题故漏看，改 **T12**。**B 段未做、单独决策**：给 `ToolResultContent` 加 `is_error`，动**已发布的 `packages/shared` 契约**与 session-log 的字节级互逆不变量（该不变量**保得住** —— 展平表达式两侧对称，把 `error` 一并还原即可）。测试 2516 → 2521（227 文件不变）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 技术委员会 |
| 2026-09-16 | **D8 立项（ghost-text 自动补全的三条缺口）** —— 用户点名的「Suggestion」= `core/autocomplete.ts` 的输入续写（`requestSuggestion` / `clearSuggestion` / `InputBar` / `config.autocomplete`）。**先给结论：接线是真的** —— 不是本仓库反复栽的「有定义、无施加点」：`app.tsx:1206-1210` 真传 config、`registry.ts:122` 的 `req.model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |            | activeModelId`让空 model 正确回退、过期结果经`isStale()`返回 null 后还有`if (completion)` 兜底、`MiphamTextInput:242`显式让位 Tab。**三条缺口按代价排序**：① **代价** ——`AUTOCOMPLETE_MAX_CONTEXT` 限的是**条数**不是 token（`recent`逐字取`m.content`、无任何截断 ⇒ 编程会话里 6 条可以是上万 token 上行），且**取消不掉**（`Llm.chat` 无 AbortSignal，`isStale()`只在**整条流消费完之后**才判）⇒ 每次 >400ms 的停顿都买一个完整 completion；② **接线层零测试** ——`test/ui/`11 个文件无一条碰 ghost text（Tab 接受 / 防抖取消 /`suggestionReqId`失效三条路径全靠人眼），而纯函数与`requestSuggestion`本身覆盖得**不差**；③ **注释漂移** ——`:314-315`声明「三处共用`clearSuggestion`」，Tab 接受路径 `:398-404`是**第四处**、只`setSuggestion(null)`（不 bump reqId、不清定时器），当前不可达（有建议显示 ⇒ 上次请求已结束）但「接受后继续续写」一加就是洞。**未修**；登记为附录 **D8** 而非 T 编号 —— 它不是 P0/P1/P2 门槛项，是低成本可顺手清的技术债。 |
| 2026-09-16 | **T12 B 段落地 —— T12 结项**：A 段修的是「无头路径**读不到**」成败位，B 段修的是**模型那一条** —— 投影消息 `ToolResultContent` 没有 `is_error`、`anthropic.ts` 照此下发 ⇒ **模型被告知每次工具调用都成功**；`session-log.messageToEvents` 又把 `success` 写死 `true` ⇒ **伪造**（比前者更坏：前者是读不到，它写下一个错值）。**唯一要拍板的是字段形状，选了「只在失败时出现」** —— A 段给 `StreamChunk.isError` 选「恒设」的理由在这里**不成立**：它要过 `daemon/database.ts` 的 `messages` 表与旧 JSONL，**历史数据里没有这个字段**，`undefined` 在可预见的将来不可能消除，恒设只剩代价（成功路径字节全变 + 请求体多一个 `is_error: false`，一次 prompt-cache 前缀抖动）。**五个改动点**：两份 `types.ts`（双副本逐字节 diff 为空）→ `context.addToolResult`（engine 两条路径的**唯一投影写点**）→ `agent/sub-agent.ts`（**第二个独立投影写点** —— 漏它即是「两条路径只接一条」的第三次）→ `session-log` 读写两侧 → `anthropic.ts`。**不变量怎么证明**：成功侧不写该键，且断言用 `'is_error' in block === false` —— 只断 `=== false` 是**抓不到恒设**的（两种实现都会绿，测试就白写了）。**先红后绿 7 红 → 全绿**；全量 2521 → 2528（227 文件不变）。**明确不改**：`openai-compat.ts`（OpenAI 的 tool 消息无此位）/ `session-worker` / `remote-engine`（A 段已通）/ microcompact / daemon `messages` 表。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-09-16 | **T2 Plan A 落地并推送 —— daemon 自启在编译产物里真能起来**（2.50.0）：`mipham daemon start` 在产物里原本**起不来、还谎报成功** —— 旧实现 `spawn('bun', ['run', <path>])` 双错：`bun` 不在 PATH（产物存在的全部理由就是用户不必装 Bun），且 `import.meta.url` 是 `$bunfs` 虚拟路径、新起的解释器读不到。改为 **re-exec 自身**（`spawn(process.execPath, […, '__daemon'])`、`detached`、**不传 `cwd`** —— 继承是硬接口，`daemonRoot = process.cwd()` 是路径白名单边界）；起不来不再谎报（轮询就绪 + spawn 错 / 早退带退出码 / 超时三条失败路径，全走非零退出码 + stderr）；`restart` 不再把旧 pid 当新结果（`waitForDaemonExit` 轮询到真退，等不到就**拒绝** —— 旧式固定 `sleep(500)` 后 `startDetachedDaemon()` 又被旧 pid 挡回，遂打印 `Daemon restarted (PID: <旧>)` 且 `exit 0`，**一个都没起**）。**判别式是本轮最隐蔽处**：`userArgs` 原按「`argv[1]` 有没有 `.ts/.js` 扩展名」分辨，而产物 argv 实测为 `["bun","/$bunfs/root/mipham",…]` —— `$bunfs` 入口**没有扩展名**却被读成首个用户参数 ⇒ `__daemon` 分支在产物里**不可达**，而源码模式恰好判对 ⇒ 单测全绿。新判别式只问**解释器是否在 `argv[0]`**（`argv0 === execPath`），两种模式都恰有两项合成前缀，与 `bin/mipham.ts` 里 12 处 `process.argv.slice(2)` 同一模型。**方法学**：`launch.test.ts` 原先给产物编了一个 bun **从不产生**的 argv 形状，那条用例在错的模型上恒绿 —— **形状断言锚在臆想形状上比没有测试更糟：它给了绿灯**。验收：新增产物冒烟 `scripts/smoke-daemon.sh` 并进 CI `build-cli` 两条（默认 PATH 与 bun 移出 PATH 各一）；**推送后首次在 CI 实跑**，两条步骤各自打印 `✓ compiled-binary daemon smoke test passed`（是步骤输出、非 run 脚本回显）⇒ 「从未在 CI 跑过」这条边界已关闭。测试 2528 → 2549（227 → 228 文件；`daemon` 179 → 200）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-09-16 | **岔路口 #2 关闭并回填**：基准定为 **Terminal-Bench**（更贴近 agent 真实形态；用户 2026-09-16 上午明确），本行同时把 ROADMAP 里仍在断言「T2 等决策」的**陈旧说法全部改到事实**。`**起手选择**：…**或** SWE-bench Verified` → 「基准已定」并补同批三件（发布模型 `deepseek-v4-pro` / 10 题 × k=1 / 接入路线 A+）；推进顺序图第 2 步由「但要一个决策 / ← 需拍板」改为「决策已拍板」，**并修掉同处另一条陈旧说法** —— `T12` **B 段**其实已于同日落地结项，图里仍写「⏳ 待单独决策」；「**仍卡在岔路口 #2**」→「已于 2026-09-16 关闭」并补「起手的前半（Plan A）亦已落地」；执行序末尾 `T2`（等决策，唯一剩下的 P0/P1 阻塞项）→「岔路口 #2 已关闭、Plan A 已落地，剩 Harbor 适配器」并补 `T12` ✅；**待决策表删去 #2 行**、移入「已决议」表（带依据与三条伴随决议）；表下说明由「#1 已关闭」改为「#1 与 #2 已关闭」。**未改基线表第 29 行**「公开基准成绩：**无**（从未跑过 SWE-bench / Terminal-Bench）」—— 它在 T2 落地前**仍是真话**，改它才是造假。**本轮只改文档、未动任何代码**，测试数与文件数不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-09-22 | **ROADMAP D5 收口 —— vendored 族整族的对等守卫**（2.89.0）。**先订正债务条目本身**：它写「两个 `constants.ts` 已分叉且无守卫」，实测只有后半句成立（两侧均 562 行、sha256 逐字相同）⇒ 记下这处订正、**不照着假前提动手**。真缺口是**覆盖面**：整族 5 对（`constants.ts` / `mipham-models.json` / `index.ts` / `package-info.ts` / `types.ts`）里只有最后一对有守卫，而模型快照与 provider 端点常量的全部价值就在值上 —— 成员集合**比不出值漂移**。新守卫 `test/integrity/shared-vendor-parity.test.ts` 把整族收进一张表，**按形状分三档**：逐字节相等 3 对；只差头部块注释 1 对（`package-info.ts`，diff 实测只有那一段，故**只剥块注释、不剥 `//`** —— 剥 `//` 会把字符串里的 URL 一起截掉，那条边界已记在 types 守卫头部）；成员集合 1 对（`types.ts`）仍由既有守卫覆盖，本文件只加一条**例外锚**（断言它既非字节相等、也非剥注释相等 ⇒ 有人把正文也同步了就红，提示改判档位）。四条断言**全部实跑负控**、各红一个用例、失败信息点名到文件与行号、还原后 sha256 逐字相符；其中「挪走副本 `index.ts`」那条如期级联到逐字节档（读它会抛）。**如实记边界**：新文件只比**文本**、不比语义 —— 两份同时被改成同一个错值**不会**让它红，别把绿读成「值是对的」。测试 3,047 → 3,051（254 → 255 文件；`test/integrity` 10/68 → 11/72）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-09-22 | **ROADMAP D3 收口 —— `~/.mipham` 收成单一真源**（2.90.0）。**先订正债务条目本身**：它写「`~/.mipham` 在 `src` 里 8 处各自独立定义」，实测 **89** 个字面量 / **52** 个文件 ⇒ 低报了一个数量级，记下订正、不照着条目里的数动手。落点即条目所指的 `core/paths.ts`：新增 `miphamHome(...segments)`（62 个调用点），项目内沿用该文件**已有**的惯用法 `join(<dir>, MIPHAM_DIR, …)`（40 处 / 12 个文件），**不造第三个 helper**。**边界（已写进函数注释）**：`miphamHome()` 必须**调用时**求值 —— `config/loader.ts` 的 `MIPHAM_HOME` 是模块作用域捕获的，`test/telemetry/index.test.ts` 靠 `vi.mock('node:os')` + `vi.hoisted` 抢在 import 前装 mock 才拦得住它 ⇒ 该函数不得改成「预先算好再传进来」（那是把调用时求值换成导入时求值）。**收尾**：重构先造出 62 条未用 `homedir`/`join`/`home` 告警，已按 eslint 报告逐条收干净（含两处**级联**：删掉 `const home = homedir()` 后同文件那行 `const { homedir } = await import('node:os')` 才变成未用）⇒ typecheck / eslint 双 0。测试数**不变**（255 文件 / 3,051 测试、0 失败）—— 纯重构，既有测试全绿即语义未变的验证。**顺带发现、只提不删**：`commands/environment.ts` 往生成的 shell 脚本里写 `export MIPHAM_HOME="${home}/.mipham"`，全仓**零读取者** —— 同一目录名的第四个名字。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-09-22 | **ROADMAP D4 收口 —— `USER_CONFIG_DIR` 删除**（2.91.0）。**先复核零消费者、不照条目信**：全仓命中只有① 定义处 ② 两份**历史档**（`docs/claude-md-history.md` 的 2.37.7 逐字存档 —— 那一条正是当初**报告**此债的原文；`docs/superpowers/plans/2026-05-31-*.md` 的时点计划）③ D3 那笔的变更记录 ⇒ **零 import 点**；两份 barrel 都是 `export *` ⇒ 删定义即足。**两侧同删**（D5 的 byte 档要求镜像）：删后两份 sha256 仍逐字相等、`git diff --numstat` 各为 `0 1`。**负控实跑**：只把那行加回**副本侧** ⇒ byte 档按预期红、失败信息点名「第 542 行」—— 即「这个删除是被守着的」。**过程事故（已回退）**：负控的还原步写了 `cd ..`，从 `apps/cli` 只退到 `apps/`，于是 `cp` 打到不存在的路径、紧接的 `rm` 又删掉了备份 ⇒ 副本侧一度仍停在变异体上；已按已知的删除行修回，并与负控前 sha256 **逐字核对相符**。测试数不变（255 文件 / 3,051 测试、0 失败）。**至此 `~/.mipham` 只剩一个名字**（`MIPHAM_DIR`，每侧一处定义、两侧逐字节相同）；第四个名字 `MIPHAM_HOME` 环境变量仍只提不删。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-09-22 | **ROADMAP D7 收口 —— 上下键历史导航的输入历史改由 `app.tsx` 持有**（2.92.0）。**先把 D7 钉成红/绿、再决定修什么**：原文「仍是 open bug …… `navigateHistory` 纯函数已正确，问题在**接线层**」**猜对了方向、指错了对象**。先补**接线层**测试（`test/ui/input-history-wiring.test.ts`；此前 `test/ui/` 17 个文件**无一条**渲染 `InputBar`，按键走 ink 的 raw 序列）：「提交后 ↑ 调回」「↑ 后 ↓ 回空草稿」「空历史 ↑ 无操作」**三条本来就绿** ⇒ 那个全称断言复现不出来。**真缺口在另一条路径**：`submittedHistory` 是 `InputBar` 的**局部 state**（`input.tsx:305`），而 `app.tsx` 有三条路径把 `InputBar` **整个卸载**（`pickerOpen ? <ModelPicker/> : <Box>…<InputBar/>…</Box>` —— 三元两支**组件类型不同** ⇒ React 卸载而非复用；`if (apiKeyPrompt)` 整棵早退；Ctrl+G）⇒ **每卸载一次历史清零**。修法：历史提到 `app.tsx`（`inputHistory` state），`InputBar` 收 `history` + `onHistoryAppend` 两个**必填** prop；两个游标 ref （`historyIndexRef` / `savedDraftRef`）**留在组件内** —— 浏览游标随卸载重置才是对的。**负控实跑**：按旧形状把历史变异回组件内（3 处锚点各命中 1 次）⇒ **只有卸载那条红**、正对照（同样重渲染但不卸载）仍绿 ⇒ 该用例是真判据不是仪式；还原后 sha256 与变异前**逐字相符**。**边界（只提不改）**：草稿 `value` 仍住组件内、切 picker 一样丢；历史**不从会话日志回填**。测试 3,051 → **3,056**（255 → 256 文件，0 失败）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-09-22 | **Shift+Tab 四档循环的接线层测试 —— 链条本来就是活的，缺的是一条「能红」的判据**（2.93.0）。**先读代码再回答，不是先答后补**：用户问「可以切换的四模式要有实际的接线、不能有死代码/空代码」，实读证据是 `Shift+Tab`（`input.tsx:404`）`→ onCyclePermission → cyclePermissionMode → ps.setMode`，四档各挂真语义（`plan` 只读 / `acceptEdits` 写放行 / `default` 要问 / `auto` 无分类器时 fail-closed）⇒ 结论是「不需要开发，需要一条能红的判据」。**此前测不到的正是接线**：`cyclePermissionMode` 只有**纯函数**用例（`test/ui/permission-mode.test.ts`），而接线只有**源码字符串**断言（`toContain('onCyclePermission')`）—— 字符串在、接线断，它照样绿。新 `test/ui/permission-cycle-wiring.test.ts`（9 用例）断三组：**按键那一跳**（真终端发的 `\x1b[Z`，不是直接调 handler —— 顺带实测 ink 的 `parse-keypress.js` 把 `[Z` 同时列进 `keyName` 与 `isShiftKey`，两者缺一这个分支在真机上就永不成立）、**转盘走完整圈**（真 `PermissionSystem`，每档复核页脚与引擎逐字相同，并加一条**字面量钉子** `['default','acceptEdits','plan','auto','default']`）、**四档不是同一个东西**（真 `check()` 逐档读数 + `acceptEdits.write ≠ plan.write`、`auto.write ≠ bypassPermissions.write`）。**四条负控全部实跑、各自只红预期那条**：禁 `key.shift && key.tab` ⇒ 只有「真终端那串」红、两条对照仍绿（8/9 passed）；禁 `acceptEdits` 写放行 ⇒ 两条分界用例红（7/9）；`cyclePermissionMode` 恒 slot 0 ⇒ 走圈红（8/9）；交换 `MODE_CYCLE` 第 2/3 档 ⇒ **只有字面量钉子红、锚在 `MODE_CYCLE` 上的断言照样绿**（8/9）—— 这正是加钉子的理由。四条还原后 sha256 与变异前**逐字相符**。**边界（只提不改）**：不渲染整个 `App`（需 ~16 个 engine 方法桩，桩可能比真对象更宽）⇒「页脚确实调用这两个入口」仍由 `test/integrity/permission-status-parity.test.ts` 从源码侧断。测试 3,056 → **3,065**（256 → **257** 文件，`test/ui` 18/211 → **19/220**，0 失败）。同笔回填 `CLAUDE.md` 的版本、头部轮转与 5 处计数。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-09-22 | **`mipham update` 把用户的 CLI 整个弄没了 —— 事故复盘 + 根因修复**（2.94.0）。**先解释现象再动手**：用户报「发版后 `mipham: command not found`」「`update` 时一直等着、然后就没有了」。根因是 `performUpdate()` 的 `execSync(..., { timeout: 600_000 })` —— npm 全局安装是**就地重写**包目录，SIGTERM 落在 `reify` 中间时旧树已删、新树没写完 ⇒ **一个 CLI 都没有**（连 `mipham update` 本身都成了自锁），而那个「保护」在一次**正常**安装途中就会开火：实测该包 84 MB / 6601 文件在本机链路上要 **>11 分钟**，计时器设在 10 分钟。**修法**是「装前快照 + 装后自证 + 失败回滚」：`resolveInstallPaths()`（对照物 `<prefix>/bin/npm`，推不出返回 null **不猜**）、launcher 存**包副本之外**的快照、安装**不带任何 timeout**、自证两关（`package.json` 版本 + launcher **实跑** `--version`）、失败则还原。**14 条新测试**全部真跑真文件；**三条负控实跑**且只红各自那条。**第一次负控是绿的，那是真发现**：它变异的是默认 runner，而用例都注入自己的 runner ⇒ 断言对象与生产对象是**两个东西**，改成默认 runner 转发调用点选项才闭合。**边界**：只保护已经装上它的机器（0.84.0 上跑 `mipham update` 仍是旧代码）；更强的原子换手另立 **D12**。测试 3,065 → **3,079**（257 → **258** 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-09-23 | **终端 Ctrl-C 曾能把安装打断到一半 —— 0.85.0 的回滚跑在「它自己也会被杀死」的那个进程里**（2.94.1）。0.85.0 修的是 SIGTERM 那条路（计时器 / npm 被杀），而 **Ctrl-C 是另一个信号、另一条路**：终端把 SIGINT 发给**整个前台进程组** ⇒ CLI 与 npm **一起**死，`performUpdate` 的 catch **永不执行** ⇒ 用户手里仍是半截树、而且这次**没有人回滚**。所以「有回滚」≠「Ctrl-C 安全」；判据要问两句：**回滚跑在哪个进程里**、**杀死它的那条信号会不会连它一起带走**。修法两道守卫（缺一，被保下来的只是一半）：① 调用点 `detached: true` ⇒ npm 自成进程组、终端的 SIGINT 到不了它（实测 `execSync` 认 detached，且**仍阻塞等它退出** 1.01s vs 1.02s ⇒ 自证仍在装完之后；`stdio:'inherit'` 输出照样打在用户终端上）；② `blockSigintDuringInstall()` ⇒ CLI 自己挂 SIGINT 守位、挂在 `finally` 上（漏撤的话 TUI 里 Ctrl-C **从此永远**没反应，比原来更糟）。**4 条新测试 + 三条负控实跑**：删 `detached` ⇒ 只红那条断言；删 `finally` ⇒ 只红两条「撤掉守位」；守位换空壳 ⇒ **vitest worker 当场被 SIGINT 杀死**（`Errors 1 error`；这条负控的形式是「进程死」而非「断言红」）；三处还原后 sha256 逐字相符。**边界**：安装期间 Ctrl-C 会被**忽略**（代价，不是附带好处）；TUI `/upgrade` 自带 SIGINT 处理；根因（npm 全局安装**没有原子换手**）未动，记在 **D12**。测试 3,079 → **3,083**（258 文件，0 失败）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-09-23 | **0.85.2 发布 —— 13 笔未发布修复归组（安全 4 笔 / 稳定性与协议 9 笔）**（2.94.2）。**四条安全修复是同一个形状：判据锚在了错误的对象上。** ① 路径型权限规则按**字面拼写**匹配 ⇒ 一个符号链接既能**擦掉** deny、也能**骗过** allow（`notes.txt` 指向 `.env` 就放行）；改按**落点**（`realpathSync`）判，且**两半分开落地** —— 只做 deny 那半，allow 那半仍是同一个洞。② 零宽字符剥离集写成**闭区间** `\u{200B}-\u{200F}`，把**承重**的 ZWNJ / ZWJ 一起吞（前者撑波斯 / 阿拉伯词形、后者让家庭 emoji 保持单字形），写盘静默改写用户内容；而执行层二者**藏不住任何东西**（`bash -c 'ec<ZWJ>ho hi'` ⇒ `command not found`）⇒ 剥离它们零收益、纯代价。③ MCP OAuth 凭证只按**服务名**复用，而服务名读自项目级 `.mcp.json` ⇒ 同名换端点 = 把旧 token 交给新主机；凭证加绑定值，四项任一变化即重授权。④ hook 的三种「没跑完」塌成同一条空理由，且 **stdin 写入与子进程退出赛跑**输掉时的 `EPIPE` 被排在退出码 / 信号之前读 ⇒ 我们自己的写失败**顶替**了子进程的真实结果。**9 笔稳定性与协议**：非原子写 + 读侧把「读不动」兜成「空」⇒ 一次半截写赔上**全部**状态（25 个模块收口 + 读侧形状闸 + 两条两向守卫）；FIFO 配置路径启动**挂死**（`existsSync` 对 FIFO 也为真、`readFileSync` **同步**阻塞到有写者 ⇒ 闸门改按**文件类型**判，新增 `shared/regular-file.ts`）；对话框里 Ctrl+C 杀掉整个 CLI（Ink `exitOnCtrlC` 默认 `true`，**任何 handler 之前**就退进程 ⇒ 自写的分支是死代码）；后台 agent 的收件箱被广告三处（`taskId` 印在输出里 / `SendMessage` 文档 / router 回 `success: true`）却**无人排空**；子代理**没有断环器**（引擎早有「连拒 3 次别重试」，子代理那条自写循环对它零引用，且只有 5 轮、无人可问）；同一段对话发给两个 provider 是**两个 payload**（provider 报错被存成 `system` 条目、`openai-compat` 原样发出 ⇒ 把 provider 文本提到最高权限角色；**汇总指令走同一条路** ⇒ 只有一半 provider 读得到）；`Task output` / `stop` 只认**本地 id 空间** ⇒ 广告出去的 `bg-…` 只可能回 not found。测试 3,083 → **3,188**（265 文件，0 失败）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-09-23 | **0.85.3 发布 —— 权限档位面的六笔收口（同一形状：接线在场而世界不变）**（2.94.3）。**六条的公共形状是「写下的那个值与真正生效的那个值不是同一个」**，只有 ⑤⑥ 两笔是新增能力：① 系统提示里的权限段**冻在启动时** —— `buildSystemPrompt(permission.getMode())` 只在建 prompt 那一刻为真，Shift+Tab 之后**没有任何地方重设** ⇒ 往宽切档时闸门开了、模型手里还是旧指令，它会拒绝做**已经允许**的事；改由 `ContextManager` **读时派生**，缝留在上下文层 —— daemon 的 ContextManager 本就不设系统提示，这正是「在哪儿读」决定「谁被顺带改变」的边界。② 子代理**从不知道自己处在哪一档**（提示按 agent 定义拼、从不含权限段）；改为报**它自己的**档，读闸门的**结果**而非定义里那个字符串（组织级 `maxAllowedMode` 会静默钳走），且必须落在**真正发出去的那份提示**上 —— 挂错地方的接线是装饰。③ **remote attach 时切档什么都不发到线上**（页脚在本地、闸门在 daemon）。④ **四条报告面报的是配置里的替身** —— `/status`、`/doctor`、`/stats`、`/setup` 读 `config.permission`，而配置文件只是几扇门里的一扇 ⇒ 可点名一个**不是**正在拒绝调用的档；新增 `liveMode(ctx)` 唯一实现，`/setup` 面板改读 `ctx.engine.getPermission().getMode()`；`/config` 的 `permission:` 行与 `/setup 5` 的两值并陈**有意保留**（前者是配置文件转储，后者本就是教这两者会分叉的地方）。⑤ **`--permission <mode>`**：`RunOptions.permission` 一路都在、**没有任何调用点传过它**，非交互场景从前只能靠 daemon 专属的 `MIPHAM_DAEMON_PERMISSION`。⑥ **`settings.json` 的 `permissions.defaultMode`** 成为一扇门，规则一句话可复述：**天花板只能由操作者自己的文件移动**（`--permission` 高于用户级 `settings.json`，高于用户级 `config.yml`，高于内建 `default`），而**项目级的两个文件不是门** —— 它们跟着代码一起来，clone 一个仓库不等于被它代授一个档位，写了就拒、并在 stderr 点名那个值与路径。测试 3,231 → **3,288**（271 文件，0 失败）；四条报告面各有一条独立钉住的负控（改回读配置 ⇒ 各自红 1），另有「两个值都印」一条（负锚有牙的证明）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-09-24 | **0.85.4 版本号落地（只 bump、未发布）+ 两条权限面缺陷，都先做了根因取证**（2.94.4）。**① `/permissions` 拒绝它自己叫你敲的拼写** —— denial 文案印 `/permissions allow "Bash"`，照它敲 `allow "Git"` 回 `Invalid rule ""Git"": not a single tool name.`：`positional[1]` **原样**当规则用（引号跟着一起进去），而所有印它的地方都印**带引号**的写法 ⇒ 照着抄必失败；且 `allow "Git" "Bash"` 里第二条（`positional[2]`）**全程没人读** ⇒ 静默丢弃。修：verb 之后按**引号**重切、逐条校验、逐条落盘；配一条 **meta-test**（从真 denial 文案里正则抠出该敲的命令再拿去执行 ⇒ 文案与命令一分叉即红）。**② auto 分类器的 `maxTokens: 200` 与模型的「思考」共享**：实测真模型（`deepseek-v4-pro`，三次真调用）~880 字符 reasoning 吃光预算 ⇒ `finish_reason=length`、可见文本 **3/3 全空** ⇒ 三次全被判「读不出来」挡下（**越该裁决的越必然饿死**，方向正好反了）；`chunk.truncated` 从没被读 ⇒ 「被上限截断」与「答复不清」同形。测试 3,288 → **3,298**（271 文件，0 失败）。**发布未做**：版本号已落地（`e3fa8991`），tag / npm publish 仍留待手动 —— **仓库文件 = 0.85.4 不等于 npm = 0.85.4**（判据取 registry + tag）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |
| 2026-09-25 | **0.85.5 发布 —— 12 笔缺陷收口（同一形状在别处又长了一遍）**（2.94.5）。① 安全：**目标读不出文本的递归 `rm`** 一律拒绝（命令替换 / 变量+根级目录名 / `$PWD` 锚定 / 只有反斜杠），闸排在放行规则与各档基线**之前**（auto 下不问分类器 —— 它读的是同一份缺失的文本），豁免走环境变量；`Retry-After` 按 [1s,60s] 夹取、不可解析退回指数退避。② 插件面三处「声明了却不落地」：远端 MCP 被装载门静默丢弃、插件钩子匿名（失败不点名 / 两个钩子共用一个禁用位 / 卸载按事件连带删光）、`mcp_tool` 钩子是空壳。③ 流面：没走到 `message_stop` 的一轮不再装成写完、重放的块不再跑两次工具、轮次上限改成「一轮对话的预算」。④ 会话面：恢复时收尾没有结果的调用（补**事件**不补投影）、中途目录被删（判据交给文件系统 —— Bun 根本不抛）、同名 MCP 并发各自起传输。⑤ UI：一刷按键不再落在上一行、命令选择器一次 Enter 只提交一遍。⑥ 新增启动时**指令总量**提示。测试 3,298 → **3,426**（271 → 291 文件，0 失败）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-09-25 | **公开面数字审出一条陈旧主张 —— 产品页 `/code` 写「85 Slash Commands」，实测 137** —— 顺手挖出 i18n 的 vendored 复制对**根本没有守卫**。**判据取命令产出**：`bun -e "…getCommandNames()…"` ⇒ **137**（`ui/commands.ts:5890`），而 `web.features.slash_commands` 在**两份副本 × 两种语言**里都写 85 ⇒ 本仓库自己的产品页（`apps/web` → `mipham.ai/code`）宣传的命令数比真值**少 52**。**修的是拷贝不是站点**（按对象扫全文件）：`packages/shared/src/i18n/locales/{en-US,zh-CN}.json`（Web 真源，`apps/web` 只读 `web.*` ⇒ 那是唯一上屏的那份）+ `apps/cli/src/i18n-core/locales/{en-US,zh-CN}.json`（CLI 自包含副本），4 文件 8 行；`docs/slash-commands-audit.md:1` 的「85」是**带日期的快照**（检测日期 2026-07-26 / v0.7.8），按「历史不可改」**不动**。**顺带量出更大的一件事**：这两份副本**从来不在** `shared-vendor-parity.test.ts` 的族表里（该守卫只守 `shared/src/*` ↔ `cli/src/shared/*`），实测**已经分叉** —— 共有 586 键中 **8 个值不同**（`commands.stats.tokens` 在 shared 侧至今硬编码 `200,000`，CLI 早已改 `{max}` 以跟上 1M/500K 自适应窗口）、CLI 独有 **245** 键、shared 独有 **10** 键，且**两侧互不包含**（shared 独有的 6 个 `web.install_page.*` 正被安装页读着）⇒ 朝任一边整体同步都会打掉对方的东西。**边界**：那 8 个分歧键都不上屏（`apps/web` 只读 `web.*`），是**死副本陈旧**、不是活缺陷。**守卫缺口**：`packages/shared/**` 同样不在 `tool-reference-integrity.test.ts` 的 `SCAN_ROOTS`（`<cli>/src` + `<cli>/bin`）里 ⇒ **两套守卫都够不着它**；已立 **D15**。**最尖的一点**：即使把这一对加进族表、按「共有键值必须相等」比，**也抓不到本笔的 85** —— 两份当时写的是**同一个错值**，值相等的守卫只会全绿（它证的是两份一致、不是两份对）⇒ 要抓它得另有**真值判据**（页面数字 vs `getCommandNames()`），而 `web.*` 目前一条都没有。**诚实边界**：本笔只让仓库里的页面正确，**未部署** —— 线上 `mipham.ai/code` 仍显示 85，直到 `apps/web` 重新构建部署（部署需单独授权）。测试数不变（4 个碰 i18n 的文件 52/52 绿）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
