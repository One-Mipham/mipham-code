# T2 — Harbor 适配器（两个基准）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Mipham Code 通过 Harbor 官方 harness 跑完两个公开基准（Phase 1 Terminal-Bench、Phase 2 SWE-bench Verified）各 10 题 × k=1，产出可复现、经得起辩护的成绩与 token 台账。

**Architecture:** 一个 Harbor 自定义 agent（`BaseInstalledAgent` 子类）+ 一个容器内 driver 进程。adapter 在宿主机跑，负责装预编译二进制、上传 driver、把题面写进容器、回读结果；driver 在任务工作目录内起 daemon，按 REST + WebSocket 驱动它跑完一个回合，把 token 数与 transcript 落盘。**容器边界是架构的成因**：daemon 在容器内绑 loopback，宿主 Python 够不着，所以七步主线全在容器内。

**Tech Stack:** Python 3.12+ 标准库（**零第三方依赖**）、Docker（Harbor 的 `-e docker`）、Mipham Code 预编译 Linux 二进制、Harbor（`~/.local/share/uv/tools/harbor/`）。

**Spec:** `docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md`

---

## Global Constraints

下列每条都是规格里的项目级要求，逐字抄自 spec（§二/§三/§四/§五/§六）。每个任务的要求隐含包含本节。带 `⚠️` 的条目是规格文字与 2026-09-16/17 实测读数不一致处 —— **按实测执行，不去改规格**（见「规格分歧」一节）。

- **`install()` 下载预编译二进制，不走 `install.sh`。**（§3.2 —— 实测 `install.sh` 在裸 Debian 里 "No runtime detected" → 装 Bun → `error: unzip is required to install bun`，mipham 一个都没装上；prebuilt 二进制实测可用）
- **权限档必须 `MIPHAM_DAEMON_PERMISSION=bypassPermissions`。**（§3.4 —— `server.ts:66-71` 的合法值；`:76-77` 注释载明 `default` 档会把 Bash/Write/Edit 挡住。不设 = 每题必挂）
- **cwd 白名单：用任务目录当 daemon 的 `daemonRoot`。**（§3.4 —— `server.ts:147 daemonRoot = process.cwd()`；`workspace-guard.ts:26-27 isCwdAllowed = isWithin(cwd, daemonRoot) || isTrusted(cwd)`）
- **鉴权：不需要 token。**（§3.4 —— `auth.ts:89-92` 只信真实 loopback 源 IP；`/api/v1/health` 免鉴权 `auth.ts:87`）
- **完成判据只有 WS 的 `done`。**（§3.4 —— `SessionStatus = 'active'|'idle'|'compacting'|'closed'`，`idle` 只在 `worker-pool.ts:116` 的 `stopWorker` 或空闲超时出现）**禁止退回轮询 `GET /messages`**：代价不是「慢一点」，而是没有可靠的回合结束判据（§3.5）。
- **`DEEPSEEK_API_KEY` 经 `self._get_env(...)` 取，注入 daemon 进程环境。**（§3.7 —— `_env_sources()` 返回 `(self._extra_env, os.environ)`，故 `--ae` 优先于 `os.environ`；`openai-compat.ts:390-400 resolveEnvTemplate` 在**运行时**从 daemon 进程的 `process.env` 解析）**变量名可入库，值永不入库、不入日志、不入结果 JSON。**
- **手写一个极简 RFC6455 WebSocket 客户端，且单列一步。**（§3.5 —— 「python3 标准库**没有** WebSocket 客户端 ⇒ 需手写一个极简 RFC6455 客户端（仅处理文本帧，约百行；客户端帧需掩码、服务端帧不需）。**这是方案 1 唯一的真实成本，须在计划里单列一步。**」）
- **Phase 1 的 token 上限 50,505,050，超限 = 中止 + 落盘已完成 + 如实披露。**（§六 —— 准绳是 token；上限由**最贵费率**反推 `$200 ÷ $3.96/1M output`，取最贵费率是为让上限**与用量构成无关地**成立；**美元那行是区间不是精确值** —— `usage` 只给两个总数、**无 cache 命中拆分**）施加点 = adapter 累加 WS `usage`（§3.6 协议事实）。
- **选题规则先于任何结果确定。**（§4.2 —— 「按数据集任务目录名的字典序，取前 10。规则**先于任何结果**确定，不含人工判断 ⇒ 结构上无法挑题。」）Phase 2 用同一精神的可机器编码变体，见 Task 6。
- **五条强制披露，一条都不能少。**（§4.1 —— ① scaffold 成绩不是模型裸能力 ② pass@1 非 pass@k ③ 每任务 tokens 与成本 ④ 复现命令 + seed ⑤ 模型选型与自家模型摸底）
- **零新增第三方依赖。** 仓库没有任何 Python（`git ls-files | grep -cE '\.py$'` = 0），`benchmarks/` 是第一份；测试用 stdlib `unittest`，不自造许可证审查负担。
- **宿主前提：`benchmarks/run-benchmark.sh` 必须能在 bash 3.2 下跑。** 本机 `/bin/bash` 是 **3.2.57**（macOS 自带），而 4.0+ 的内建（`mapfile` / `readarray` / `declare -A` 等）在这里**不存在** —— 用了它们的脚本会在**第一步就 `command not found`（退出码 127）**，报出的错与被执行的那段逻辑毫无关系。实测：计划早期版本 Task 11 Step 2 的 `mapfile -t TASKS < <(…)` 正是这一形态，已改为 `mktemp` + `while IFS= read -r` + `trap`（登记 #16）。**新增 shell 一律先 `bash -n` 再 `--tasks-only` 空跑**（Task 11 Step 2 就是为此存在）。
- **交付物按 §五：** 适配器 `benchmarks/harbor/mipham_code.py` / 复现脚本 / 结果 JSON / 根 `README.md`（复现命令 + 选题规则 + 五条披露）/ 产品页 `../websites/domestic/`、`../websites/international/`（**父仓子模块，按 §十五 规矩走**）。
- **子模块红线：** 永不在父仓库中修改子模块文件。改 `websites` 必须在 `websites/` 内 commit/push，父仓只 `git add websites` 更新 gitlink。每次父仓提交前跑 `git ls-files -s <sub>` == 子模块 HEAD。
- **`--ae` 是唯一的环境通道。**（本计划的规定，理由见「架构决定 ④」）adapter 的一切可调量走 `--ae KEY=VALUE` + `self._get_env("KEY")`，不走 `-ak`。实测：`--ae` 落进 `AgentConfig.env` 并在 `--print-config` 里打码显示，`-ak` 落进 `kwargs` 且**未声明的 kwarg 静默进 kwargs 不报错** —— 即 `-ak` 打错字会静默失效（本仓库「有定义、无施加点」的又一形态）。
- **禁止自动提交 / 禁止自动推送。** 每个任务的 `git commit` 是**子仓库 `mipham-code` 内的本地提交**，是本计划明确要求的步骤；`git push` 一律需要新的明确授权。

### 规格分歧（须用户裁决，本计划不擅自改规格）

四条规格文字与实测对不上或已不完整。计划按实测执行并把差异**写在 `benchmarks/README.md` 里**，规格本身一字未动：

1. **「官方现役数据集 66 题」（spec `:8`、`:14`、§七#10）** —— 实测 `harbor datasets download terminal-bench@2.0` 落地 **89 个任务目录**（`Successfully downloaded 89 task(s)`）。两个读数可能都对而对象不同：**66** 是上游仓库 `laude-institute/terminal-bench-2` 的 `tasks/dataset.toml` 里 `[[tasks]]` 的出现次数，**89** 是 Harbor registry 的 `terminal-bench@2.0` 条目；`harbor run -d terminal-bench@2.0` 实际调度的是后者。**本计划的选题规则施加在 89 上**，因为那是被调度的对象；不去断言哪个数字「对」。
2. **标题里的「Terminal-Bench 4.0」（spec `:1`、`:14`）** —— registry 里没有任何 4.0 条目；实际用的是 `terminal-bench@2.0`（entry 名 `terminal-bench`，89 题）。计划统一写 `terminal-bench@2.0`。
3. **规格没有一处讲「数据集下载在宿主侧走代理」**（规格 `docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md` 里「代理」5 处：`:164`/`:166`/`:273`/`:274`/`:337`，**全部在容器→宿主 / 模型调用侧**；这一条描述的是**规格该说而没说**，不是可测读数）—— 而 dataset 下载在**本机**必须走 `127.0.0.1:7897`（`github.com` 被墙），模型调用走**无代理**的 `api.deepseek.com:443`（实测 TLS 1.3 / 0.96s 国内直连）。规格自己立的原则是「可复现性不该依赖一条代理链路」，所以这两条网络依赖**必须分开写进披露**。本计划的做法是把代理**只挂在数据集下载那一条命令上**（`harbor datasets download`），`harbor run` 一律用 `-p <本地目录>` 且不继承代理 —— 既分开披露，也避免代理变量渗进容器把模型调用带偏。
4. **规格通篇没有 SWE-bench 阶段** —— 用户 2026-09-16 追加「两个都测」，本计划的 Phase 2 是它的唯一权威描述。

---

## 架构决定（每条都由实测钉住，不是偏好）

1. **一个 driver 进程干完全部七步。** 因为 `HOME` 必须在 daemon 的整个生命周期里保持一致（端口/pid/token/db 全在 `$HOME/.mipham/`）。分多次 `exec_as_agent` 就要靠 shell 传 `HOME`，任何一次漏传都会让第二次调用看不到第一次起的 daemon。
2. **adapter 与 driver 之间只有一个接口：`exec_as_agent` 一次 + 读回两个文件。** 题面走 `upload_file`（不经 shell，无需 quote）；结果走 `/logs/agent/mipham-result.json`；逐事件 transcript 走 `/logs/agent/mipham-transcript.jsonl`。`/logs/agent` 是 `EnvironmentPaths.agent_dir`，`TrialPaths.chmod_dir()` 已把它 chmod 0777 且是挂载回宿主的，所以容器里写、宿主读，不需要 `download_file`。
3. **`HOME=/logs/agent/home`。** daemon 的 `daemon.port` / `daemon.pid` / `daemon.token` / `daemon.db` / `daemon.log` 全落在这里 ⇒ 随 trial 挂载回到宿主 `trial_dir/agent/` 供归因。代价：SQLite 会进产物目录，这是**有意**的（它是会话的唯一持久记录）。
4. **所有可调量走 `--ae`，`MiphamCodeOptions` 保持空。** 见 Global Constraints 末条。
5. **二进制装到 `/tmp/mipham/mipham`，不装 `/usr/local/bin`。** `exec_as_agent` 以 agent 用户跑，`/usr/local/bin` 不保证可写；`/tmp` 在所有基础镜像里都是 world-writable。代价：每个容器重新下载 83.6 MB（任何路径下都是每题一次，反正是同一量级）。
6. **driver 增量落盘。** transcript 每收到一条帧就 `write + flush`；result JSON 在**每次状态变迁时**重写。这样即使 harbor 的 agent timeout 触发、driver 被 SIGKILL，已完成的部分仍在盘上 —— 这是「中止 + 落盘已完成 + 如实披露」能被兑现的机制，不是尽力而为。
7. **台账在宿主侧。** adapter 每题一个新实例，作业级上限只能放进程外：`benchmarks/results/ledger.json` + `fcntl.flock`。每题预算 = `remaining()`；题名不参与记账（`record(tokens, note=...)` 记的是流水），因为 adapter 拿不到可靠的题名，而题名与用量的配对由复现脚本在作业目录里做。
8. **`n_cache_tokens` 与 `cost_usd` 一律留 `None`。** WS `usage` 只给 `inputTokens`/`outputTokens` 两个总数（`attach-protocol.ts:35-40`），没有 cache 命中拆分 ⇒ 填它们就是编造。

## 已实测钉住的外部事实（照抄，别重查）

| 事实                                                                        | 值                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harbor 自定义 agent 传法                                                    | `-a 'benchmarks.harbor.mipham_code:MiphamCode'` + `PYTHONPATH=<repo root>`；**必须是可导入模块路径，不能是文件路径**（`importlib.import_module`）                                                                                                               |
| 该传法已验                                                                  | `--dry-run` → `Dry run OK — 1 trial(s)`；`name()` 返回枚举外的 `"mipham-code"` 被接受                                                                                                                                                                           |
| `options_model`                                                             | **必需** —— 不声明报 `Agent 'mipham-code' does not declare an options_model`                                                                                                                                                                                    |
| 本地数据集                                                                  | `harbor datasets download terminal-bench@2.0 -o <out>`（**位置参数，没有 `-d`**）⇒ `<out>/terminal-bench/<task>/`，89 个                                                                                                                                        |
| 跑本地数据集                                                                | `harbor run -p <out>/terminal-bench -i <name> ...`（`-p/--path` = "Path to a local task or dataset directory"）                                                                                                                                                 |
| 二进制                                                                      | `https://github.com/One-Mipham/mipham-code/releases/download/v0.81.7/mipham-linux-x64`（`apps/cli/package.json` version = `0.81.7`，与 release tag 一致；**钉 tag 不用 `latest`**）                                                                             |
| Python 解释器                                                               | adapter 测试必须用**能 import harbor 的解释器**：`~/.local/share/uv/tools/harbor/bin/python`                                                                                                                                                                    |
| Phase 1 十题（`sorted()` 前 10，已对 89 个真实目录名验过）                  | `adaptive-rejection-sampler` `bn-fit-modify` `break-filter-js-from-html` `build-cython-ext` `build-pmars` `build-pov-ray` `caffe-cifar-10` `cancel-async-tasks` `chess-best-move` `circuit-fibsqrt`                                                             |
| Phase 2 十题（`sorted()` 后按 `__` 前缀去重取前 10 个仓库，各取字典序首个） | `astropy__astropy-12907` `django__django-10097` `matplotlib__matplotlib-13989` `mwaskom__seaborn-3069` `pallets__flask-5014` `psf__requests-1142` `pydata__xarray-2905` `pylint-dev__pylint-4551` `pytest-dev__pytest-10051` `scikit-learn__scikit-learn-10297` |
| 端口文件                                                                    | `~/.mipham/daemon.port` 内容就是端口号的十进制字符串（`index.ts:252 writeFileSync(PORT_FILE, String(port))`）                                                                                                                                                   |
| daemon 子命令                                                               | `mipham daemon start\|stop\|status\|restart`（`bin/mipham.ts:415`）                                                                                                                                                                                             |
| `DaemonSession`                                                             | `{id, name, cwd, provider, model, status, createdAt, updatedAt, closedAt, turnCount, tokenIn, tokenOut}`（`daemon/types.ts:8-21`）—— **`tokenIn`/`tokenOut` 是 daemon 自己持久化的用量**，与 WS 累加值互为对照（Task 8 两者都记，不一致就披露）                 |

## 文件结构

```
benchmarks/                              # 本仓库第一份 Python
├── __init__.py                          # 空；使 benchmarks 成为可导入包（harbor -a 需要）
├── README.md                            # 复现命令 + 选题规则 + 五条披露 + 规格分歧四条（Task 14/19）
├── harbor/
│   ├── __init__.py                      # 空
│   ├── mipham_code.py                   # 适配器：MiphamCodeOptions + MiphamCode（Task 9/10）
│   └── driver/                          # 整目录 upload_dir 进容器
│       ├── __init__.py                  # 空
│       ├── ws.py                        # 手写 RFC6455 客户端（Task 1/2/3）
│       ├── protocol.py                  # attach-protocol 纯归约器（Task 4）
│       ├── client.py                    # daemon REST 客户端（Task 5）
│       └── main.py                      # 七步编排（Task 8）
├── tasks.py                             # 两个数据集的选题规则 + 录制值 + CLI（Task 6）
├── budget.py                            # 习题级 token 台账 + CLI（Task 7）
├── run-benchmark.sh                     # 复现脚本（Task 11）
├── results/                             # 结果 JSON + 台账（提交）
├── jobs/                                # harbor 作业目录（.gitignore，不提交）
├── .datasets/                           # 下载的数据集（.gitignore，不提交）
└── test/
    ├── __init__.py
    ├── test_ws.py                       # Task 1/2/3
    ├── test_protocol.py                 # Task 4
    ├── test_client.py                   # Task 5
    ├── test_tasks.py                    # Task 6
    ├── test_budget.py                   # Task 7
    └── test_adapter.py                  # Task 9/10（须用 harbor 的解释器跑）
```

`benchmarks/.gitignore` 内容（Task 1 创建）：

```
jobs/
.datasets/
results/ledger.json
__pycache__/
```

**测试命令（全计划统一）：**

```bash
cd <repo root>
export PYTHONPATH="$PWD"
BH="$HOME/.local/share/uv/tools/harbor/bin/python"
"$BH" -m unittest discover -s benchmarks/test -t . -v
```

---

# Phase 1 — Terminal-Bench（`terminal-bench@2.0`，89 题，取前 10）

---

### Task 1: 包骨架 + RFC6455 握手与帧编码

**Files:**

- Create: `benchmarks/__init__.py`, `benchmarks/harbor/__init__.py`, `benchmarks/harbor/driver/__init__.py`, `benchmarks/test/__init__.py`（四个空文件）
- Create: `benchmarks/.gitignore`
- Create: `benchmarks/harbor/driver/ws.py`
- Test: `benchmarks/test/test_ws.py`

**Interfaces:**

- Consumes: 无（第一个任务）
- Produces:
  - `ws.WS_GUID: str`
  - `ws.OP_TEXT/OP_CLOSE/OP_PING/OP_PONG: int`
  - `ws.WsError(Exception)`
  - `ws.compute_accept(key: str) -> str`
  - `ws.encode_frame(opcode: int, payload: bytes, *, mask: bool, fin: bool = True) -> bytes`

- [ ] **Step 1: 建骨架**

```bash
cd <repo root>
mkdir -p benchmarks/harbor/driver benchmarks/test benchmarks/results
touch benchmarks/__init__.py benchmarks/harbor/__init__.py \
      benchmarks/harbor/driver/__init__.py benchmarks/test/__init__.py
printf 'jobs/\n.datasets/\nresults/ledger.json\n__pycache__/\n' > benchmarks/.gitignore
```

- [ ] **Step 2: 写失败的测试**

```python
# benchmarks/test/test_ws.py
import unittest

from benchmarks.harbor.driver import ws


class ComputeAcceptTest(unittest.TestCase):
    def test_rfc6455_section_1_3_vector(self):
        # The canonical example from RFC 6455 §1.3.
        self.assertEqual(
            ws.compute_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        )


class EncodeFrameTest(unittest.TestCase):
    def test_short_text_frame_is_masked_and_round_trips(self):
        frame = ws.encode_frame(ws.OP_TEXT, b"hello", mask=True)
        self.assertEqual(len(frame), 11)  # 2 header + 4 mask + 5 payload
        self.assertEqual(frame[0], 0x81)  # FIN + text opcode
        self.assertEqual(frame[1], 0x85)  # mask bit + length 5
        key = frame[2:6]
        # This verifies the payload against the key read out of the *same*
        # frame, so it is satisfied by any key at all — including a constant.
        # It pins the layout and the XOR, not the entropy: that is what the
        # next test is for.
        self.assertEqual(
            bytes(b ^ key[i % 4] for i, b in enumerate(frame[6:])),
            b"hello",
        )

    def test_masking_key_is_not_a_constant(self):
        # RFC 6455 §5.3 requires the masking key to come from a strong source
        # of entropy. Nothing above tests that: reading the key back out of the
        # frame and un-XORing with it proves consistency, never randomness, and
        # b"\x00\x00\x00\x00" is a valid-looking key (the XOR is the identity).
        # So pin the property directly — two encodes of the same payload must
        # not reuse a key. That kills every key computed from this call's own
        # inputs (constant, all-zero, payload- or opcode-derived) at a
        # false-failure probability of 2**-32 — but it does *not* catch a key
        # derived from call history: a counter returns two different values
        # here while staying fully deterministic. Separating that from
        # os.urandom needs statistical testing, which is out of scope. This
        # pins the property every honest implementation satisfies.
        first = ws.encode_frame(ws.OP_TEXT, b"hello", mask=True)[2:6]
        second = ws.encode_frame(ws.OP_TEXT, b"hello", mask=True)[2:6]
        self.assertNotEqual(first, second)

    def test_unmasked_frame_carries_payload_verbatim(self):
        frame = ws.encode_frame(ws.OP_TEXT, b"hello", mask=False)
        self.assertEqual(frame, b"\x81\x05hello")

    def test_length_encoding_boundaries(self):
        self.assertEqual(ws.encode_frame(ws.OP_TEXT, b"x" * 125, mask=False)[1], 125)
        two = ws.encode_frame(ws.OP_TEXT, b"x" * 126, mask=False)
        self.assertEqual(two[1], 126)
        self.assertEqual(two[2:4], b"\x00\x7e")
        eight = ws.encode_frame(ws.OP_TEXT, b"x" * 65536, mask=False)
        self.assertEqual(eight[1], 127)
        self.assertEqual(eight[2:10], b"\x00\x00\x00\x00\x00\x01\x00\x00")

    def test_masked_extended_lengths_keep_the_mask_bit(self):
        # Every boundary case above passes mask=False, so the `flag | 126` and
        # `flag | 127` branches are never exercised with the mask bit set — a
        # mutant dropping `flag` in either survives. A masked frame's key sits
        # at 2 + len(extended length): 4 for 16-bit, 10 for 64-bit, versus 2
        # for the 7-bit case the first test covers. Pin the bit *and* the
        # layout, since Task 2's parser must read that offset back.
        for payload, key_at in ((b"x" * 126, 4), (b"x" * 65536, 10)):
            frame = ws.encode_frame(ws.OP_TEXT, payload, mask=True)
            self.assertEqual(frame[1] & 0x80, 0x80, len(payload))
            key = frame[key_at : key_at + 4]
            self.assertEqual(
                bytes(b ^ key[i % 4] for i, b in enumerate(frame[key_at + 4 :])),
                payload,
                len(payload),
            )

    def test_fin_flag_is_clearable(self):
        self.assertEqual(ws.encode_frame(ws.OP_TEXT, b"", mask=False, fin=False)[0], 0x01)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_ws -v`
Expected: FAIL —— `ImportError: cannot import name 'ws' from 'benchmarks.harbor.driver'`（Python 3.14：父包已存在时不报 `ModuleNotFoundError`；Task 1 实测的报错形状）

- [ ] **Step 4: 写最小实现**

```python
# benchmarks/harbor/driver/ws.py
"""Minimal RFC 6455 client, text frames only.

The Python standard library ships no WebSocket client and this repository
takes no third-party dependencies, so what is here *is* the client
(spec §3.5 calls this the one real cost of the adapter approach).

Client-to-server frames MUST be masked and server-to-client frames MUST NOT
be (RFC 6455 §5.1) — the asymmetry is why :func:`encode_frame` takes a
``mask`` flag rather than picking a side.
"""

from __future__ import annotations

import base64
import hashlib
import os
import struct

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WsError(Exception):
    """A protocol violation, or a close we did not ask for."""


def compute_accept(key: str) -> str:
    """``Sec-WebSocket-Accept`` for a client's ``Sec-WebSocket-Key``."""
    digest = hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _xor(payload: bytes, key: bytes) -> bytes:
    return bytes(byte ^ key[index % 4] for index, byte in enumerate(payload))


def encode_frame(opcode: int, payload: bytes, *, mask: bool, fin: bool = True) -> bytes:
    """Encode one unfragmented frame."""
    out = bytearray()
    out.append((0x80 if fin else 0x00) | opcode)
    length = len(payload)
    flag = 0x80 if mask else 0x00
    if length < 126:
        out.append(flag | length)
    elif length < 65536:
        out.append(flag | 126)
        out += struct.pack("!H", length)
    else:
        out.append(flag | 127)
        out += struct.pack("!Q", length)
    if mask:
        key = os.urandom(4)
        out += key
        out += _xor(payload, key)
    else:
        out += payload
    return bytes(out)
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_ws -v`
Expected: PASS（7 个测试 —— ComputeAcceptTest 1 + EncodeFrameTest 6）

- [ ] **Step 6: 提交**

```bash
git add benchmarks/
git commit -m "feat(bench): 手写 RFC6455 客户端的握手与帧编码（T2 Plan B 第 1 件）

Python 标准库没有 WebSocket 客户端，而 spec §3.5 把「手写一个极简
RFC6455 客户端」列为方案 1 唯一的真实成本。本笔落它的握手与帧编码
一半：compute_accept 对 RFC 6455 §1.3 的官方向量，encode_frame 覆盖
7/16/64 位长度编码与掩码开关。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: RFC6455 帧解码器（跨 TCP 分块）

**Files:**

- Modify: `benchmarks/harbor/driver/ws.py`（追加 `FrameParser`）
- Test: `benchmarks/test/test_ws.py`（追加一个 `TestCase` 类）

**Interfaces:**

- Consumes: `ws.WsError`、`ws.encode_frame`（Task 1）
- Produces: `ws.FrameParser`，方法 `feed(data: bytes) -> list[tuple[int, bytes]]`

**为什么这个任务单独存在：** TCP 不保证帧边界。`recv(65536)` 可能一次给你三条帧，也可能只给你半条。把「缓冲 + 取完整帧」做成一个独立的纯对象，才能不靠 socket 就测住它 —— 这正是最容易写错、也最难在集成层发现的地方。

- [ ] **Step 1: 写失败的测试**

```python
# 追加到 benchmarks/test/test_ws.py 末尾（import 段不动）
class FrameParserTest(unittest.TestCase):
    def test_whole_frame(self):
        parser = ws.FrameParser()
        self.assertEqual(parser.feed(b"\x81\x05hello"), [(ws.OP_TEXT, b"hello")])

    def test_split_across_every_boundary_is_identical(self):
        parser_whole = ws.FrameParser()
        frame = ws.encode_frame(ws.OP_TEXT, b"a longer payload", mask=True)
        self.assertEqual(parser_whole.feed(frame), [(ws.OP_TEXT, b"a longer payload")])

        for cut in range(1, len(frame)):
            parser = ws.FrameParser()
            frames = parser.feed(frame[:cut]) + parser.feed(frame[cut:])
            self.assertEqual(frames, [(ws.OP_TEXT, b"a longer payload")], f"cut={cut}")

    def test_partial_frame_is_withheld(self):
        parser = ws.FrameParser()
        self.assertEqual(parser.feed(b"\x81\x05hel"), [])
        self.assertEqual(parser.feed(b"lo"), [(ws.OP_TEXT, b"hello")])

    def test_two_frames_in_one_chunk(self):
        parser = ws.FrameParser()
        chunk = b"\x81\x03one" + b"\x81\x03two"
        self.assertEqual(parser.feed(chunk), [(ws.OP_TEXT, b"one"), (ws.OP_TEXT, b"two")])

    def test_extended_length_16_bit(self):
        parser = ws.FrameParser()
        payload = b"x" * 300
        frame = ws.encode_frame(ws.OP_TEXT, payload, mask=False)
        self.assertEqual(parser.feed(frame), [(ws.OP_TEXT, payload)])

    def test_extended_length_64_bit(self):
        parser = ws.FrameParser()
        payload = b"y" * 70000
        frame = ws.encode_frame(ws.OP_TEXT, payload, mask=False)
        self.assertEqual(parser.feed(frame), [(ws.OP_TEXT, payload)])

    def test_fragmented_frame_is_rejected_loudly(self):
        parser = ws.FrameParser()
        with self.assertRaises(ws.WsError):
            parser.feed(ws.encode_frame(ws.OP_TEXT, b"ab", mask=False, fin=False))
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_ws -v`
Expected: FAIL —— `AttributeError: module 'benchmarks.harbor.driver.ws' has no attribute 'FrameParser'`

- [ ] **Step 3: 写最小实现**

```python
# 追加到 benchmarks/harbor/driver/ws.py 末尾
class FrameParser:
    """Incremental frame decoder: feed arbitrary chunks, get whole frames.

    Buffers whatever cannot be completed yet, so the caller never has to
    think about TCP segmentation.
    """

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> list[tuple[int, bytes]]:
        self._buf += data
        frames: list[tuple[int, bytes]] = []
        while True:
            frame = self._take()
            if frame is None:
                return frames
            frames.append(frame)

    def _take(self) -> tuple[int, bytes] | None:
        buf = self._buf
        if len(buf) < 2:
            return None
        first, second = buf[0], buf[1]
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        offset = 2
        if length == 126:
            if len(buf) < offset + 2:
                return None
            length = struct.unpack("!H", bytes(buf[offset : offset + 2]))[0]
            offset += 2
        elif length == 127:
            if len(buf) < offset + 8:
                return None
            length = struct.unpack("!Q", bytes(buf[offset : offset + 8]))[0]
            offset += 8
        key = b""
        if masked:
            if len(buf) < offset + 4:
                return None
            key = bytes(buf[offset : offset + 4])
            offset += 4
        if len(buf) < offset + length:
            return None
        payload = bytes(buf[offset : offset + length])
        del buf[: offset + length]
        if masked:
            payload = _xor(payload, key)
        if not first & 0x80:
            raise WsError("fragmented frames are not supported")
        return opcode, payload
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_ws -v`
Expected: PASS（14 个测试 —— ComputeAcceptTest 1 + EncodeFrameTest 6 + FrameParserTest 7）

- [ ] **Step 5: 提交**

```bash
git add benchmarks/harbor/driver/ws.py benchmarks/test/test_ws.py
git commit -m "feat(bench): RFC6455 帧解码器跨 TCP 分块不丢帧（T2 Plan B 第 2 件）

FrameParser 把「缓冲 + 取完整帧」做成纯对象，因此可以不碰 socket
就测住它：对同一条帧在每一个可能的位置切开重放，结果必须逐字相同。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: RFC6455 连接与控制帧

**Files:**

- Modify: `benchmarks/harbor/driver/ws.py`（追加 `WsConnection` 与握手辅助）
- Test: `benchmarks/test/test_ws.py`（追加 `FakeSocket` + `WsConnectionTest`）

**Interfaces:**

- Consumes: `ws.FrameParser`（Task 2）、`ws.encode_frame`、`ws.compute_accept`（Task 1）
- Produces:
  - `ws.WsConnection.connect(host: str, port: int, path: str, *, timeout_sec: float | None = None) -> WsConnection`
  - `ws.WsConnection.send_text(text: str) -> None`
  - `ws.WsConnection.recv_text() -> str | None`（对端 close 时返回 `None`）
  - `ws.WsConnection.close() -> None`

**为什么 `recv_text` 而不是 `recv_frame`：** 控制帧（ping/pong/close）不该泄漏给调用者 —— 调用者只关心「下一条协议消息」，而 daemon 在长回合里可能发 ping。把 ping→pong 的应答放在这一层，才有一处能测它。

- [ ] **Step 1: 写失败的测试**

```python
# 追加到 benchmarks/test/test_ws.py 末尾
class FakeSocket:
    """A socket-shaped object that replays canned bytes and records writes."""

    def __init__(self, incoming: bytes) -> None:
        self._incoming = bytearray(incoming)
        self.sent = bytearray()
        self.closed = False

    def recv(self, _size: int) -> bytes:
        if not self._incoming:
            return b""
        chunk = bytes(self._incoming[:7])  # deliberately not aligned to frames
        del self._incoming[:7]
        return chunk

    def sendall(self, data: bytes) -> None:
        self.sent += data

    def close(self) -> None:
        self.closed = True


class _connect_with(ws.WsConnection, object):
    pass


class WsConnectionTest(unittest.TestCase):
    def _connection(self, incoming: bytes) -> tuple[ws.WsConnection, FakeSocket]:
        sock = FakeSocket(incoming)
        return ws.WsConnection(sock), sock

    def test_recv_text_returns_the_payload(self):
        conn, _ = self._connection(ws.encode_frame(ws.OP_TEXT, b"hi", mask=False))
        self.assertEqual(conn.recv_text(), "hi")

    def test_recv_text_answers_ping_with_pong_then_yields_text(self):
        conn, sock = self._connection(
            ws.encode_frame(ws.OP_PING, b"ping-payload", mask=False)
            + ws.encode_frame(ws.OP_TEXT, b"after-ping", mask=False)
        )
        self.assertEqual(conn.recv_text(), "after-ping")
        expected = ws.encode_frame(ws.OP_PONG, b"ping-payload", mask=True)
        self.assertEqual(sock.sent[:2], expected[:2])  # opcode + masked length
        self.assertEqual(
            bytes(b ^ sock.sent[2:6][i % 4] for i, b in enumerate(sock.sent[6:])),
            b"ping-payload",
        )

    def test_recv_text_returns_none_on_close(self):
        conn, _ = self._connection(ws.encode_frame(ws.OP_CLOSE, b"", mask=False))
        self.assertIsNone(conn.recv_text())

    def test_recv_text_raises_when_peer_disappears(self):
        sock = FakeSocket(b"")
        with self.assertRaises(ws.WsError):
            ws.WsConnection(sock).recv_text()

    def test_close_sends_a_close_frame_and_closes_the_socket(self):
        conn, sock = self._connection(b"")
        conn.close()
        self.assertEqual(sock.sent[0], 0x88)  # FIN + close opcode
        self.assertTrue(sock.closed)

    def test_connect_accepts_a_correct_accept(self):
        # Positive control. Without it, every negative test below would still
        # pass against an implementation that raised unconditionally.
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        self.assertEqual(ws.compute_accept(key), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

        class AcceptingSocket(FakeSocket):
            def __init__(self) -> None:
                super().__init__(
                    b"HTTP/1.1 101 Switching Protocols\r\n"
                    b"Upgrade: websocket\r\n"
                    b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
                    b"\r\n"
                )

        conn = ws.WsConnection._from_socket(AcceptingSocket(), key)
        self.assertIsInstance(conn, ws.WsConnection)

    def test_connect_rejects_a_non_101_status(self):
        class RefusingSocket(FakeSocket):
            def __init__(self) -> None:
                super().__init__(b"HTTP/1.1 403 Forbidden\r\n\r\n")

        with self.assertRaises(ws.WsError):
            ws.WsConnection._from_socket(RefusingSocket(), "dGhlIHNhbXBsZSBub25jZQ==")

    def test_connect_rejects_a_mismatched_accept(self):
        # The header carries a *real* accept value — just one computed from a
        # different key — so this proves the comparison is keyed to the key we
        # actually sent, not merely that some header was present.
        class MismatchedSocket(FakeSocket):
            def __init__(self) -> None:
                super().__init__(
                    b"HTTP/1.1 101 Switching Protocols\r\n"
                    b"Upgrade: websocket\r\n"
                    b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
                    b"\r\n"
                )

        with self.assertRaises(ws.WsError):
            ws.WsConnection._from_socket(
                MismatchedSocket(), "AAAAAAAAAAAAAAAAAAAAAA=="
            )

    def test_connect_rejects_a_101_without_an_accept_header(self):
        class NoHeaderSocket(FakeSocket):
            def __init__(self) -> None:
                super().__init__(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"
                )

        with self.assertRaises(ws.WsError):
            ws.WsConnection._from_socket(NoHeaderSocket(), "dGhlIHNhbXBsZSBub25jZQ==")

    def test_recv_text_raises_on_invalid_utf8(self):
        frame = ws.encode_frame(ws.OP_TEXT, b"\xff\xfe", mask=False)
        conn, _ = self._connection(frame)
        with self.assertRaises(ws.WsError):
            conn.recv_text()
```

> 测试用 `_from_socket` 这个内部构造函数，是为了在不真连 socket 的前提下测握手校验。`connect()` 只是「建 socket → 发请求 → 调 `_from_socket`」，那三行由 Task 12 的集成门覆盖。

- [ ] **Step 2: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_ws -v`
Expected: FAIL —— `AttributeError: module 'benchmarks.harbor.driver.ws' has no attribute 'WsConnection'`

- [ ] **Step 3: 写最小实现**

```python
# 追加到 benchmarks/harbor/driver/ws.py 末尾
import socket  # 与其余 import 合并到文件顶部


class WsConnection:
    """One WebSocket connection: text in, text out, control frames handled."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._parser = FrameParser()
        self._ready: list[tuple[int, bytes]] = []

    @classmethod
    def connect(
        cls,
        host: str,
        port: int,
        path: str,
        *,
        timeout_sec: float | None = None,
    ) -> "WsConnection":
        sock = socket.create_connection((host, port), timeout=timeout_sec)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))
        return cls._from_socket(sock, key)

    @classmethod
    def _from_socket(cls, sock: socket.socket, key: str) -> "WsConnection":
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = sock.recv(4096)
            if not chunk:
                raise WsError("connection closed during handshake")
            raw += chunk
        header = raw.decode("latin-1")
        status = header.split("\r\n", 1)[0]
        if "101" not in status:
            raise WsError(f"handshake rejected: {status}")
        expected = compute_accept(key)
        for line in header.split("\r\n"):
            name, _, value = line.partition(":")
            if name.strip().lower() == "sec-websocket-accept":
                if value.strip() != expected:
                    raise WsError("Sec-WebSocket-Accept does not match the key we sent")
                conn = cls(sock)
                # Anything the server sent after the handshake is already ours.
                _, _, rest = raw.partition(b"\r\n\r\n")
                if rest:
                    conn._ready.extend(conn._parser.feed(rest))
                return conn
        raise WsError("handshake carried no Sec-WebSocket-Accept")

    def _next_frame(self) -> tuple[int, bytes]:
        while not self._ready:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise WsError("connection closed by peer")
            self._ready.extend(self._parser.feed(chunk))
        return self._ready.pop(0)

    def send_text(self, text: str) -> None:
        self._sock.sendall(encode_frame(OP_TEXT, text.encode("utf-8"), mask=True))

    def recv_text(self) -> str | None:
        """The next text message, or ``None`` once the peer closes."""
        while True:
            opcode, payload = self._next_frame()
            if opcode == OP_TEXT:
                try:
                    return payload.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise WsError("text frame is not valid UTF-8") from exc
            if opcode == OP_CLOSE:
                return None
            if opcode == OP_PING:
                self._sock.sendall(encode_frame(OP_PONG, payload, mask=True))
                continue
            if opcode == OP_PONG:
                continue
            raise WsError(f"unsupported opcode 0x{opcode:x}")

    def close(self) -> None:
        try:
            self._sock.sendall(encode_frame(OP_CLOSE, b"", mask=True))
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_ws -v`
Expected: PASS（24 个测试 = ComputeAcceptTest 1 + EncodeFrameTest 6 + FrameParserTest 7 + WsConnectionTest 10；订正：此处历经 18 → 20 → 24，**每一版都是按算式推演、每一版都错** —— 18 漏计 Task 1 修复轮补的 2；20 → 24 是本任务评审修复轮把「握手校验只测到状态码分支」拆成 4 条（正对照 + 3 条拒绝）并补 1 条 UTF-8 用例，实测 24。以 `unittest` 实跑输出为准）

- [ ] **Step 5: 提交**

```bash
git add benchmarks/harbor/driver/ws.py benchmarks/test/test_ws.py
git commit -m "feat(bench): RFC6455 连接层 —— 控制帧不外泄，握手校验不放松（T2 Plan B 第 3 件）

recv_text 只让协议消息出去：ping 就地回 pong、pong 忽略、close 返回
None。handshake 校验真的算 Sec-WebSocket-Accept 并逐字比对，而不是
看到 101 就放行。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: attach-protocol 归约器

**Files:**

- Create: `benchmarks/harbor/driver/protocol.py`
- Test: `benchmarks/test/test_protocol.py`

**Interfaces:**

- Consumes: 无（纯函数，只依赖 stdlib）
- Produces:
  - `protocol.TEXT/TOOL_USE/TOOL_RESULT/USAGE/TASK_NOTIFICATION/DONE/ERROR/SESSION_STATE: str`
  - `protocol.SERVER_TYPES: frozenset[str]`
  - `protocol.ProtocolError(Exception)`
  - `protocol.TurnState`（dataclass: `input_tokens` `output_tokens` `turns` `tool_results` `tool_errors` `stop_reason` `last_error` `finished`；property `total_tokens -> int`）
  - `protocol.reduce_message(state: TurnState, raw: str) -> dict`

- [ ] **Step 1: 写失败的测试**

```python
# benchmarks/test/test_protocol.py
import unittest

from benchmarks.harbor.driver import protocol


class ReduceMessageTest(unittest.TestCase):
    def test_usage_frames_accumulate(self):
        # The daemon emits one usage frame per LLM call (spec §3.6), so a
        # task's token count is a sum, never a single frame.
        state = protocol.TurnState()
        protocol.reduce_message(
            state, '{"type":"usage","sessionId":"s","inputTokens":100,"outputTokens":20}'
        )
        protocol.reduce_message(
            state, '{"type":"usage","sessionId":"s","inputTokens":300,"outputTokens":40}'
        )
        self.assertEqual(state.input_tokens, 400)
        self.assertEqual(state.output_tokens, 60)
        self.assertEqual(state.total_tokens, 460)

    def test_text_frame_moves_no_counters(self):
        state = protocol.TurnState()
        protocol.reduce_message(state, '{"type":"text","sessionId":"s","content":"hi"}')
        self.assertEqual(state.total_tokens, 0)

    def test_tool_result_counts_errors_only_when_iserror_is_true(self):
        state = protocol.TurnState()
        protocol.reduce_message(
            state, '{"type":"tool_result","sessionId":"s","toolId":"t1","content":"ok"}'
        )
        protocol.reduce_message(
            state,
            '{"type":"tool_result","sessionId":"s","toolId":"t2","content":"boom","isError":true}',
        )
        self.assertEqual(state.tool_results, 2)
        self.assertEqual(state.tool_errors, 1)

    def test_done_ends_the_turn(self):
        state = protocol.TurnState()
        protocol.reduce_message(
            state, '{"type":"done","sessionId":"s","stopReason":"end_turn"}'
        )
        self.assertTrue(state.finished)
        self.assertEqual(state.stop_reason, "end_turn")

    def test_error_is_recorded_and_ends_the_turn(self):
        state = protocol.TurnState()
        protocol.reduce_message(state, '{"type":"error","sessionId":"s","message":"nope"}')
        self.assertTrue(state.finished)
        self.assertEqual(state.last_error, "nope")

    def test_unknown_type_is_loud(self):
        # Protocol drift must not be silently swallowed: a new server frame
        # that we ignore is a counter we never see.
        state = protocol.TurnState()
        with self.assertRaises(protocol.ProtocolError):
            protocol.reduce_message(state, '{"type":"something_new","sessionId":"s"}')

    def test_malformed_json_is_loud(self):
        state = protocol.TurnState()
        with self.assertRaises(protocol.ProtocolError):
            protocol.reduce_message(state, "not json at all")

    def test_reduce_returns_the_parsed_message(self):
        state = protocol.TurnState()
        parsed = protocol.reduce_message(
            state, '{"type":"text","sessionId":"s","content":"hi"}'
        )
        self.assertEqual(parsed["content"], "hi")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_protocol -v`
Expected: FAIL —— `ImportError: cannot import name 'protocol' from 'benchmarks.harbor.driver'`（Python 3.14：父包已存在时不报 `ModuleNotFoundError`；Task 1 实测的报错形状）

- [ ] **Step 3: 写最小实现**

```python
# benchmarks/harbor/driver/protocol.py
"""Pure reducers over the daemon attach protocol.

The wire shapes mirror ``apps/cli/src/daemon/attach-protocol.ts``. Keeping the
reduction separate from the socket and the subprocess is what makes "tokens are
a protocol fact, not an estimate" (spec §3.6) testable without a daemon.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

TEXT = "text"
TOOL_USE = "tool_use"
TOOL_RESULT = "tool_result"
USAGE = "usage"
TASK_NOTIFICATION = "task_notification"
DONE = "done"
ERROR = "error"
SESSION_STATE = "session_state"

SERVER_TYPES = frozenset(
    {TEXT, TOOL_USE, TOOL_RESULT, USAGE, TASK_NOTIFICATION, DONE, ERROR, SESSION_STATE}
)


class ProtocolError(Exception):
    """A frame we do not understand, or one we cannot parse."""


@dataclass
class TurnState:
    input_tokens: int = 0
    output_tokens: int = 0
    turns: int = 0
    tool_results: int = 0
    tool_errors: int = 0
    stop_reason: str | None = None
    last_error: str | None = None
    finished: bool = False

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


def reduce_message(state: TurnState, raw: str) -> dict:
    """Fold one server frame into ``state``; return the parsed message.

    Extends ``state`` in place and returns the parsed dict so the caller can
    persist the frame verbatim as the transcript line.
    """
    try:
        message = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"unparseable frame: {raw[:200]!r}") from exc
    if not isinstance(message, dict):
        raise ProtocolError(f"frame is not a JSON object: {raw[:200]!r}")

    kind = message.get("type")
    if kind not in SERVER_TYPES:
        raise ProtocolError(f"unknown server frame type {kind!r}")

    if kind == USAGE:
        state.input_tokens += int(message.get("inputTokens") or 0)
        state.output_tokens += int(message.get("outputTokens") or 0)
    elif kind == TOOL_RESULT:
        state.tool_results += 1
        if message.get("isError"):
            state.tool_errors += 1
    elif kind == DONE:
        state.turns += 1
        state.stop_reason = message.get("stopReason")
        state.finished = True
    elif kind == ERROR:
        state.last_error = message.get("message")
        state.finished = True

    return message
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_protocol -v`
Expected: PASS（8 个测试）

- [ ] **Step 5: 提交**

```bash
git add benchmarks/harbor/driver/protocol.py benchmarks/test/test_protocol.py
git commit -m "feat(bench): attach-protocol 归约器 —— usage 累加、done 收束、未知帧报警（T2 Plan B 第 4 件）

tokens 是协议事实而非估算的来源在 §3.6：daemon 每次 LLM 调用发一条
usage，所以一道题的 token 数是一个求和、不是某一帧的值。未知类型的
帧一律抛错而不是忽略 —— 忽略掉的那条正是没被计数的那个数。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: daemon REST 客户端

**Files:**

- Create: `benchmarks/harbor/driver/client.py`
- Test: `benchmarks/test/test_client.py`

**Interfaces:**

- Consumes: 无（stdlib `urllib.request` + `http.server` 只在测试里）
- Produces:
  - `client.DaemonError(Exception)`
  - `client.PORT_FILE_RELATIVE: str` = `".mipham/daemon.port"`
  - `client.read_port(home: str, timeout_sec: float = 30.0) -> int`
  - `client.DaemonClient(port: int)`，方法：
    - `health() -> dict`
    - `wait_until_ready(timeout_sec: float = 60.0) -> dict`
    - `create_session(*, name: str, cwd: str, provider: str, model: str) -> str`（返回 session id）
    - `prompt(session_id: str, text: str) -> None`
    - `session(session_id: str) -> dict`

- [ ] **Step 1: 写失败的测试**

```python
# benchmarks/test/test_client.py
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from benchmarks.harbor.driver import client


class _Handler(BaseHTTPRequestHandler):
    """A stand-in daemon that records requests and replays canned replies."""

    responses: dict[tuple[str, str], tuple[int, dict]] = {}
    seen: list[tuple[str, str, dict | None]] = []

    def _reply(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's API
        _Handler.seen.append(("GET", self.path, None))
        status, body = _Handler.responses.get(
            ("GET", self.path), (404, {"ok": False, "error": "Not found"})
        )
        self._reply(status, body)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        parsed = json.loads(raw) if raw else None
        _Handler.seen.append(("POST", self.path, parsed))
        status, body = _Handler.responses.get(
            ("POST", self.path), (404, {"ok": False, "error": "Not found"})
        )
        self._reply(status, body)

    def log_message(self, *args: object) -> None:
        pass


class DaemonClientTest(unittest.TestCase):
    def setUp(self) -> None:
        _Handler.responses = {}
        _Handler.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        # addCleanup runs LIFO, so these must be registered in reverse of the
        # order they have to run (shutdown -> server_close -> join):
        # join() on a thread parked in serve_forever() only returns once
        # shutdown() has been called, and shutdown() does not close the
        # listening socket — skipping server_close() leaks it until GC, which
        # surfaces as a ResourceWarning in the middle of the next test.
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def test_read_port_returns_the_integer_in_the_port_file(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, ".mipham"))
            with open(os.path.join(home, ".mipham", "daemon.port"), "w") as handle:
                handle.write("45671\n")
            self.assertEqual(client.read_port(home, timeout_sec=0.5), 45671)

    def test_read_port_gives_up_loudly(self):
        with tempfile.TemporaryDirectory() as home:
            with self.assertRaises(client.DaemonError):
                client.read_port(home, timeout_sec=0.3)

    def test_create_session_sends_cwd_and_returns_the_id(self):
        path = "/api/v1/sessions"
        _Handler.responses[("POST", path)] = (
            201,
            {"ok": True, "data": {"session": {"id": "sess-1", "cwd": "/task"}}},
        )
        session_id = client.DaemonClient(self.port).create_session(
            name="t2", cwd="/task", provider="deepseek", model="deepseek-v4-pro"
        )
        self.assertEqual(session_id, "sess-1")
        _, _, body = _Handler.seen[-1]
        self.assertEqual(body, {
            "name": "t2",
            "cwd": "/task",
            "provider": "deepseek",
            "model": "deepseek-v4-pro",
        })

    def test_a_403_carries_the_daemon_explanation(self):
        # The cwd whitelist is the failure this adapter is most likely to hit
        # (spec §3.4), so the error text has to survive the trip.
        path = "/api/v1/sessions"
        _Handler.responses[("POST", path)] = (
            403,
            {
                "ok": False,
                "error": "cwd must be a trusted workspace or inside the daemon directory",
            },
        )
        with self.assertRaises(client.DaemonError) as caught:
            client.DaemonClient(self.port).create_session(
                name="t2", cwd="/elsewhere", provider="deepseek", model="m"
            )
        self.assertIn("trusted workspace", str(caught.exception))

    def test_prompt_posts_the_text_to_the_session(self):
        path = "/api/v1/sessions/sess-1/prompt"
        _Handler.responses[("POST", path)] = (
            202,
            {"ok": True, "data": {"sessionId": "sess-1", "status": "processing"}},
        )
        client.DaemonClient(self.port).prompt("sess-1", "do the thing")
        _, _, body = _Handler.seen[-1]
        self.assertEqual(body, {"prompt": "do the thing"})

    def test_wait_until_ready_polls_health_then_returns_it(self):
        _Handler.responses[("GET", "/api/v1/health")] = (200, {"ok": True, "pid": 7})
        health = client.DaemonClient(self.port).wait_until_ready(timeout_sec=5.0)
        self.assertTrue(health["ok"])

    def test_session_returns_the_row(self):
        path = "/api/v1/sessions/sess-1"
        _Handler.responses[("GET", path)] = (
            200,
            {"ok": True, "data": {"session": {"id": "sess-1", "tokenIn": 12}}},
        )
        row = client.DaemonClient(self.port).session("sess-1")
        self.assertEqual(row["tokenIn"], 12)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_client -v`
Expected: FAIL —— `ImportError: cannot import name 'client' from 'benchmarks.harbor.driver'`（Python 3.14：父包已存在时不报 `ModuleNotFoundError`；Task 1 实测的报错形状）

- [ ] **Step 3: 写最小实现**

```python
# benchmarks/harbor/driver/client.py
"""REST client for the Mipham daemon (spec §3.3 steps ②③⑤).

Loopback needs no token (spec §3.4), so there is nothing to authenticate with
here — ``/api/v1/health`` is unauthenticated by design (``auth.ts:87``) and the
rest trusts a genuine loopback source address (``auth.ts:89-92``).
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

PORT_FILE_RELATIVE = os.path.join(".mipham", "daemon.port")


class DaemonError(Exception):
    """The daemon refused, vanished, or answered with something we cannot use."""


def read_port(home: str, timeout_sec: float = 30.0) -> int:
    """Wait for ``$HOME/.mipham/daemon.port`` to appear and parse it."""
    path = os.path.join(home, PORT_FILE_RELATIVE)
    deadline = time.monotonic() + timeout_sec
    while True:
        try:
            with open(path, encoding="utf-8") as handle:
                return int(handle.read().strip())
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                raise DaemonError(f"no readable port file at {path} after {timeout_sec}s")
            time.sleep(0.2)


class DaemonClient:
    def __init__(self, port: int) -> None:
        self._base = f"http://127.0.0.1:{port}"

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            self._base + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise DaemonError(f"{method} {path} → HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise DaemonError(f"{method} {path} → {exc.reason}") from exc

    def health(self) -> dict:
        return self._request("GET", "/api/v1/health")

    def wait_until_ready(self, timeout_sec: float = 60.0) -> dict:
        deadline = time.monotonic() + timeout_sec
        last: Exception | None = None
        while time.monotonic() < deadline:
            try:
                health = self.health()
                if health.get("ok"):
                    return health
            except DaemonError as exc:
                last = exc
            time.sleep(0.25)
        raise DaemonError(f"daemon never became ready: {last}")

    def create_session(self, *, name: str, cwd: str, provider: str, model: str) -> str:
        reply = self._request(
            "POST",
            "/api/v1/sessions",
            {"name": name, "cwd": cwd, "provider": provider, "model": model},
        )
        try:
            return str(reply["data"]["session"]["id"])
        except (KeyError, TypeError) as exc:
            raise DaemonError(f"unexpected session reply: {reply!r}") from exc

    def prompt(self, session_id: str, text: str) -> None:
        self._request("POST", f"/api/v1/sessions/{session_id}/prompt", {"prompt": text})

    def session(self, session_id: str) -> dict:
        reply = self._request("GET", f"/api/v1/sessions/{session_id}")
        try:
            return dict(reply["data"]["session"])
        except (KeyError, TypeError) as exc:
            raise DaemonError(f"unexpected session reply: {reply!r}") from exc
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_client -v`
Expected: PASS（7 个测试）

- [ ] **Step 5: 提交**

```bash
git add benchmarks/harbor/driver/client.py benchmarks/test/test_client.py
git commit -m "feat(bench): daemon REST 客户端（T2 Plan B 第 5 件）

测试用 stdlib http.server 起一个真 HTTP 端，不是 mock：403 的 body
必须原样带出来，因为 cwd 白名单正是这个适配器最可能撞上的那道墙
（spec §3.4），把它的解释吃掉就等于把最有用的诊断吃掉。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 选题规则（两个数据集）

**Files:**

- Create: `benchmarks/tasks.py`
- Test: `benchmarks/test/test_tasks.py`

**Interfaces:**

- Consumes: 无
- Produces:
  - `tasks.select_first(names: list[str], n: int) -> list[str]`
  - `tasks.select_first_repos(names: list[str], n: int) -> list[str]`
  - `tasks.PHASE1_DATASET: str` = `"terminal-bench@2.0"`
  - `tasks.PHASE2_DATASET: str` = `"swebench-verified@1.0"`
  - `tasks.PHASE1_EXPECTED: tuple[str, ...]`（10 个，已对 89 个真实目录名验过）
  - `tasks.PHASE2_EXPECTED: tuple[str, ...]`（10 个）
  - `tasks.main(argv: list[str]) -> int` —— CLI：`--dataset-dir DIR --rule first|first-repos --n N --expect-recorded`

- [ ] **Step 1: 写失败的测试**

```python
# benchmarks/test/test_tasks.py
import unittest

from benchmarks import tasks


class SelectFirstTest(unittest.TestCase):
    def test_lexicographic_prefix(self):
        names = ["delta", "alpha", "charlie", "bravo"]
        self.assertEqual(tasks.select_first(names, 2), ["alpha", "bravo"])

    def test_does_not_mutate_its_input(self):
        names = ["b", "a"]
        tasks.select_first(names, 1)
        self.assertEqual(names, ["b", "a"])

    def test_n_larger_than_the_dataset_returns_everything(self):
        self.assertEqual(tasks.select_first(["b", "a"], 10), ["a", "b"])


class SelectFirstReposTest(unittest.TestCase):
    def test_one_task_per_repository_in_lexicographic_order(self):
        names = [
            "astropy__astropy-6938",
            "django__django-10874",
            "astropy__astropy-12907",
            "django__django-10097",
            "psf__requests-1142",
        ]
        self.assertEqual(
            tasks.select_first_repos(names, 3),
            ["astropy__astropy-12907", "django__django-10097", "psf__requests-1142"],
        )

    def test_a_name_without_a_separator_is_its_own_repository(self):
        # The second name must come from a *different* repository prefix: a
        # separator-less name's repository is the whole name, so pairing it with
        # "alpha__x-1" would collide on "alpha" and be deduped away.
        self.assertEqual(tasks.select_first_repos(["alpha", "beta__x-1"], 2), ["alpha", "beta__x-1"])


class RecordedSelectionTest(unittest.TestCase):
    def test_phase1_records_ten_distinct_names(self):
        self.assertEqual(len(tasks.PHASE1_EXPECTED), 10)
        self.assertEqual(len(set(tasks.PHASE1_EXPECTED)), 10)
        self.assertEqual(list(tasks.PHASE1_EXPECTED), sorted(tasks.PHASE1_EXPECTED))

    def test_phase2_records_ten_distinct_repositories(self):
        self.assertEqual(len(tasks.PHASE2_EXPECTED), 10)
        repos = [name.split("__", 1)[0] for name in tasks.PHASE2_EXPECTED]
        self.assertEqual(len(set(repos)), 10)

    def test_phase2_names_are_in_lexicographic_order(self):
        # A necessary condition of the rule, not the rule itself: taking the
        # first name per repository in lexicographic order can only ever yield a
        # sorted list, so an out-of-order record means the rule was not applied.
        # It cannot pin the rule — a list holding each repository's *last* name
        # would also be sorted. Pinning it needs the dataset, which Phase 2 has.
        self.assertEqual(list(tasks.PHASE2_EXPECTED), sorted(tasks.PHASE2_EXPECTED))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_tasks -v`
Expected: FAIL —— `ImportError: cannot import name 'tasks' from 'benchmarks'`（Python 3.14：父包已存在时不报 `ModuleNotFoundError`；Task 1 实测的报错形状）

- [ ] **Step 3: 写最小实现**

```python
# benchmarks/tasks.py
"""Which tasks each phase runs, decided before any result exists (spec §4.2).

Phase 1 uses the dataset's own lexicographic order, exactly as the spec states.
Phase 2 needs a variant because SWE-bench Verified task names are
``<owner>__<repo>-<pr>``: plain lexicographic order yields ten tasks from a
single repository, which measures one codebase rather than ten. The variant is
the same rule with the repository as the unit — still no human judgement, still
computable from the dataset listing alone.
"""

from __future__ import annotations

import argparse
import os
import sys

PHASE1_DATASET = "terminal-bench@2.0"
PHASE2_DATASET = "swebench-verified@1.0"

# Recorded from the datasets' own directory listings on 2026-09-16/17. The
# reproduce script recomputes both from the downloaded files and refuses to run
# if they differ, so these are assertions, not inputs.
PHASE1_EXPECTED: tuple[str, ...] = (
    "adaptive-rejection-sampler",
    "bn-fit-modify",
    "break-filter-js-from-html",
    "build-cython-ext",
    "build-pmars",
    "build-pov-ray",
    "caffe-cifar-10",
    "cancel-async-tasks",
    "chess-best-move",
    "circuit-fibsqrt",
)
PHASE2_EXPECTED: tuple[str, ...] = (
    "astropy__astropy-12907",
    "django__django-10097",
    "matplotlib__matplotlib-13989",
    "mwaskom__seaborn-3069",
    "pallets__flask-5014",
    "psf__requests-1142",
    "pydata__xarray-2905",
    "pylint-dev__pylint-4551",
    "pytest-dev__pytest-10051",
    "scikit-learn__scikit-learn-10297",
)


def _repository(name: str) -> str:
    return name.split("__", 1)[0]


def select_first(names: list[str], n: int) -> list[str]:
    """The lexicographically first ``n`` names (spec §4.2's rule)."""
    return sorted(names)[:n]


def select_first_repos(names: list[str], n: int) -> list[str]:
    """The first task of each of the lexicographically first ``n`` repositories."""
    chosen: list[str] = []
    seen: set[str] = set()
    for name in sorted(names):
        repository = _repository(name)
        if repository in seen:
            continue
        seen.add(repository)
        chosen.append(name)
        if len(chosen) == n:
            break
    return chosen


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Recompute a phase's task selection.")
    parser.add_argument("--dataset-dir", required=True, help="Directory holding the task dirs.")
    parser.add_argument("--rule", choices=("first", "first-repos"), required=True)
    parser.add_argument("--n", type=int, required=True)
    parser.add_argument("--expect-recorded", action="store_true")
    args = parser.parse_args(argv)

    names = sorted(
        entry
        for entry in os.listdir(args.dataset_dir)
        if os.path.isdir(os.path.join(args.dataset_dir, entry))
    )
    selected = select_first(names, args.n) if args.rule == "first" else select_first_repos(names, args.n)

    if args.expect_recorded:
        recorded = PHASE1_EXPECTED if args.rule == "first" else PHASE2_EXPECTED
        if tuple(selected) != recorded:
            print(
                "selection drifted from the recorded list:\n"
                f"  computed: {selected}\n"
                f"  recorded: {list(recorded)}",
                file=sys.stderr,
            )
            return 1

    for name in selected:
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_tasks -v`
Expected: PASS（8 个测试）

- [ ] **Step 5: 对真实数据集复算一遍（这是本任务的验收，不是可选项）**

Run:

```bash
"$BH" -m benchmarks.tasks --dataset-dir benchmarks/.datasets/terminal-bench \
    --rule first --n 10 --expect-recorded
```

若 `benchmarks/.datasets/` 还没有数据集，先下载（**代理只挂这一条命令**）：

```bash
cd <repo root>
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  harbor datasets download terminal-bench@2.0 -o benchmarks/.datasets
```

Expected: 打印 10 行，退出码 0，首行 `adaptive-rejection-sampler`、末行 `circuit-fibsqrt`。

- [ ] **Step 6: 提交**

```bash
git add benchmarks/tasks.py benchmarks/test/test_tasks.py
git commit -m "feat(bench): 两个阶段的选题规则先于任何结果确定（T2 Plan B 第 6 件）

Phase 1 用 spec §4.2 的原规则（目录名字典序前 10）。Phase 2 必须换
一个原子：SWE-bench Verified 的题名是 <owner>__<repo>-<pr>，纯字典序
会十题全落在同一个仓库里 —— 那不是抽样，是测一个代码库。变体把
「单位」从任务换成仓库，仍然不含人工判断，仍可从目录列表算出来。

录制值不是输入而是断言：复现脚本从下载到的真实目录重算，不一致就
拒绝开跑。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 习题级 token 台账

**Files:**

- Create: `benchmarks/budget.py`
- Test: `benchmarks/test/test_budget.py`

**Interfaces:**

- Consumes: 无
- Produces:
  - `budget.DEFAULT_CEILING: int` = `50_505_050`
  - `budget.Ledger(path: str | os.PathLike[str], ceiling: int = DEFAULT_CEILING)`，方法：
    - `remaining() -> int`
    - `record(tokens: int, *, note: str = "", at: str | None = None) -> int`（返回记录后的 `remaining()`）
    - `entries() -> list[dict]`
    - `reset() -> None`
  - `budget.main(argv: list[str]) -> int` —— CLI：`init` / `show`

**为什么台账在宿主侧：** Harbor 每题起一个 adapter 实例，进程内状态活不到下一题。上限是**作业级**的，所以记账必须在进程外、且并发安全（`fcntl.flock`），否则一道题用超了会被下一题「重新开始」抵消掉。

- [ ] **Step 1: 写失败的测试**

```python
# benchmarks/test/test_budget.py
import json
import os
import tempfile
import threading
import unittest

from benchmarks import budget


class LedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "ledger.json")

    def test_a_fresh_ledger_has_the_whole_ceiling_left(self):
        ledger = budget.Ledger(self.path, ceiling=1000)
        self.assertEqual(ledger.remaining(), 1000)
        self.assertEqual(ledger.entries(), [])

    def test_recording_subtracts_from_the_remaining(self):
        ledger = budget.Ledger(self.path, ceiling=1000)
        self.assertEqual(ledger.record(400, note="task-a"), 600)
        self.assertEqual(ledger.record(100, note="task-b"), 500)

    def test_the_ceiling_survives_a_new_instance(self):
        budget.Ledger(self.path, ceiling=1000).record(250)
        self.assertEqual(budget.Ledger(self.path, ceiling=999).remaining(), 750)

    def test_overspending_goes_negative_rather_than_clamping(self):
        # Clamping would hide how far past the ceiling a run actually went.
        ledger = budget.Ledger(self.path, ceiling=100)
        self.assertEqual(ledger.record(150), -50)

    def test_notes_and_timestamps_are_persisted(self):
        budget.Ledger(self.path, ceiling=100).record(5, note="circuit-fibsqrt", at="2026-09-17T00:00:00Z")
        with open(self.path, encoding="utf-8") as handle:
            state = json.load(handle)
        self.assertEqual(state["ceiling"], 100)
        self.assertEqual(state["entries"][0]["note"], "circuit-fibsqrt")
        self.assertEqual(state["entries"][0]["at"], "2026-09-17T00:00:00Z")

    def test_concurrent_records_do_not_lose_a_write(self):
        # The adapter is one process per task; without the lock two tasks
        # racing here would silently overwrite each other's usage.
        ledger = budget.Ledger(self.path, ceiling=10_000)
        threads = [
            threading.Thread(target=ledger.record, args=(1,), kwargs={"note": f"t{i}"})
            for i in range(20)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(ledger.entries()), 20)
        self.assertEqual(ledger.remaining(), 10_000 - 20)

    def test_reset_clears_the_entries_but_keeps_the_ceiling(self):
        ledger = budget.Ledger(self.path, ceiling=500)
        ledger.record(10)
        ledger.reset()
        self.assertEqual(ledger.remaining(), 500)
        self.assertEqual(ledger.entries(), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_budget -v`
Expected: FAIL —— `ImportError: cannot import name 'budget' from 'benchmarks'`（Python 3.14：父包已存在时不报 `ModuleNotFoundError`；Task 1 实测的报错形状）

- [ ] **Step 3: 写最小实现**

```python
# benchmarks/budget.py
"""Job-level token ledger (spec §六).

Harbor runs one agent instance per task, so a job-level ceiling cannot live in
any instance. This is a file plus an exclusive lock: each task's budget is the
remaining headroom, so the job stops at the ceiling instead of at whichever
task happens to overshoot it.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
from datetime import datetime, timezone

DEFAULT_CEILING = 50_505_050


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Ledger:
    def __init__(self, path: str | os.PathLike[str], ceiling: int = DEFAULT_CEILING) -> None:
        self.path = os.fspath(path)
        self.ceiling = ceiling

    def _read(self) -> dict:
        try:
            with open(self.path, encoding="utf-8") as handle:
                state = json.load(handle)
        except FileNotFoundError:
            return {"ceiling": self.ceiling, "entries": []}
        state.setdefault("ceiling", self.ceiling)
        state.setdefault("entries", [])
        return state

    def entries(self) -> list[dict]:
        return list(self._read()["entries"])

    def remaining(self) -> int:
        state = self._read()
        return int(state["ceiling"]) - sum(int(entry["tokens"]) for entry in state["entries"])

    def reset(self) -> None:
        self._write(self._read()["ceiling"], [])

    def record(self, tokens: int, *, note: str = "", at: str | None = None) -> int:
        """Append usage and return the new remaining headroom."""
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        lock_path = self.path + ".lock"
        with open(lock_path, "a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                state = self._read()
                state["entries"].append({"tokens": int(tokens), "note": note, "at": at or _now()})
                self._write(state["ceiling"], state["entries"])
                return int(state["ceiling"]) - sum(int(e["tokens"]) for e in state["entries"])
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _write(self, ceiling: int, entries: list[dict]) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"ceiling": ceiling, "entries": entries}, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, self.path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect or create the benchmark token ledger.")
    parser.add_argument("--path", required=True)
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    init.add_argument("--ceiling", type=int, default=DEFAULT_CEILING)
    init.add_argument("--fresh", action="store_true", help="Discard recorded usage.")

    sub.add_parser("show")

    args = parser.parse_args(argv)
    ledger = Ledger(args.path, ceiling=getattr(args, "ceiling", DEFAULT_CEILING))

    if args.command == "init":
        if args.fresh:
            ledger.reset()
        else:
            ledger._write(ledger._read()["ceiling"], ledger._read()["entries"])
        print(f"ceiling={ledger.ceiling} remaining={ledger.remaining()} entries={len(ledger.entries())}")
        return 0

    state = ledger._read()
    print(json.dumps({"ceiling": state["ceiling"], "remaining": ledger.remaining(),
                      "entries": state["entries"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_budget -v`
Expected: PASS（7 个测试）

- [ ] **Step 5: 提交**

```bash
git add benchmarks/budget.py benchmarks/test/test_budget.py
git commit -m "feat(bench): 作业级 token 台账（T2 Plan B 第 7 件）

上限是作业级的，而 Harbor 每题起一个新的 adapter 实例 —— 进程内
状态活不到下一题，所以记账必须在进程外。用 20 线程各记一笔来证明
锁真的在场：没有 flock 的话，互相覆盖会让用量凭空少掉。

超支记成负数而不是截到 0 —— 截掉的是「超了多少」这个事实。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: driver 七步主线

**Files:**

- Create: `benchmarks/harbor/driver/main.py`
- Test: `benchmarks/test/test_driver_main.py`

**Interfaces:**

- Consumes: `ws.WsConnection`（Task 3）、`protocol.TurnState/reduce_message/USAGE/DONE`（Task 4）、`client.DaemonClient/read_port/DaemonError`（Task 5）
- Produces:
  - `main.STEP_ORDER: tuple[str, ...]` = `("start_daemon", "health", "session", "websocket", "prompt", "wait_done", "persist")`
  - `main.REQUIRED_ENV: tuple[str, ...]`
  - `main.driver_env() -> dict[str, str]`
  - `main.run() -> dict`
  - `main.main() -> int`

**driver 读的环境（全部由 adapter 用 `exec_as_agent(env=...)` 注入）：**

| 变量                       | 来源                                   | 缺省                                  |
| -------------------------- | -------------------------------------- | ------------------------------------- |
| `HOME`                     | driver 自己设成 `/logs/agent/home`     | 必填                                  |
| `MIPHAM_DAEMON_PERMISSION` | adapter `_get_env` 或 `--ae`           | 必填，值必须是 `bypassPermissions`    |
| `DEEPSEEK_API_KEY`         | adapter `_get_env("DEEPSEEK_API_KEY")` | 必填，**本模块永不打印它的值**        |
| `MIPHAM_BUDGET_TOKENS`     | adapter 从台账读的剩余额度             | 必填                                  |
| `MIPHAM_EXEC_TIMEOUT_SEC`  | adapter `_get_env`                     | `840`                                 |
| `MIPHAM_BINARY`            | adapter 常量                           | `/tmp/mipham/mipham`                  |
| `MIPHAM_PROMPT_PATH`       | adapter 常量                           | `/logs/agent/mipham-prompt.txt`       |
| `MIPHAM_RESULT_PATH`       | adapter 常量                           | `/logs/agent/mipham-result.json`      |
| `MIPHAM_TRANSCRIPT_PATH`   | adapter 常量                           | `/logs/agent/mipham-transcript.jsonl` |
| `MIPHAM_DRIVER_LOG_PATH`   | adapter 常量                           | `/logs/agent/mipham-driver.log`       |
| `MIPHAM_SESSION_PROVIDER`  | adapter `_get_env`                     | `deepseek`                            |
| `MIPHAM_SESSION_MODEL`     | adapter `_get_env`                     | `deepseek-v4-pro`                     |

- [ ] **Step 1: 写失败的测试**

先用一个只有 `client`/`ws`/`protocol` 能被替换的纯函数边界 —— `driver_env()` 与 `run()` 的状态机骨架不碰 socket，因此可测：

```python
# benchmarks/test/test_driver_main.py
import os
import unittest

from benchmarks.harbor.driver import main


class DriverEnvTest(unittest.TestCase):
    def test_required_keys_are_all_read_from_the_environment(self):
        self.assertIn("MIPHAM_BUDGET_TOKENS", main.REQUIRED_ENV)
        self.assertIn("DEEPSEEK_API_KEY", main.REQUIRED_ENV)
        self.assertIn("MIPHAM_DAEMON_PERMISSION", main.REQUIRED_ENV)

    def test_missing_required_key_names_itself(self):
        # Failing loudly here is the difference between "the score is 0" and
        # "we never got a key" — the two look identical from the results file.
        with self.assertRaises(main.DriverConfigError) as caught:
            main.driver_env({})
        self.assertIn("MIPHAM_BUDGET_TOKENS", str(caught.exception))

    def test_defaults_fill_in_the_paths(self):
        env = main.driver_env(
            {
                "HOME": "/logs/agent/home",
                "MIPHAM_BUDGET_TOKENS": "1000",
                "DEEPSEEK_API_KEY": "secret-value",
                "MIPHAM_DAEMON_PERMISSION": "bypassPermissions",
            }
        )
        self.assertEqual(env["MIPHAM_BINARY"], "/tmp/mipham/mipham")
        self.assertEqual(env["MIPHAM_RESULT_PATH"], "/logs/agent/mipham-result.json")
        self.assertEqual(env["MIPHAM_EXEC_TIMEOUT_SEC"], "840")

    def test_the_permission_mode_is_pinned_to_bypass(self):
        # spec §3.4: the default mode blocks Bash/Write/Edit, so every task
        # would fail for a reason that has nothing to do with the model.
        env = main.driver_env(
            {
                "HOME": "/logs/agent/home",
                "MIPHAM_BUDGET_TOKENS": "1000",
                "DEEPSEEK_API_KEY": "k",
                "MIPHAM_DAEMON_PERMISSION": "default",
            }
        )
        self.assertEqual(env["MIPHAM_DAEMON_PERMISSION"], "bypassPermissions")


class StepOrderTest(unittest.TestCase):
    def test_the_websocket_is_connected_before_the_prompt_is_sent(self):
        # Not a style choice: getOrCreateWorker registers the clients already
        # in wsClients for that session, so a prompt sent first would stream
        # into nothing and the run would hang with no `done` (spec §3.4).
        self.assertLess(main.STEP_ORDER.index("websocket"), main.STEP_ORDER.index("prompt"))

    def test_all_seven_steps_are_present(self):
        self.assertEqual(len(main.STEP_ORDER), 7)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_driver_main -v`
Expected: FAIL —— `ImportError: cannot import name 'main' from 'benchmarks.harbor.driver'`（Python 3.14：父包已存在时不报 `ModuleNotFoundError`；Task 1 实测的报错形状）

- [ ] **Step 3: 写实现**

```python
# benchmarks/harbor/driver/main.py
"""Drive the Mipham daemon through one task, inside the task container.

All seven steps of spec §3.3 live in one process because ``HOME`` has to stay
identical across the daemon's whole lifetime — the port file, pid file, token
and SQLite database all live under ``$HOME/.mipham``, so splitting the steps
across shell invocations means any missed ``HOME`` makes the second call
invisible to the first's daemon.

Runs as ``python3 /logs/agent/mipham-driver/main.py``; the ``__package__``
check below lets the same file be imported as ``benchmarks.harbor.driver.main``
by the test suite.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

if __package__:
    from . import client as client_module
    from . import protocol, ws
else:  # pragma: no cover — the container runs this file as a script
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import client as client_module
    import protocol
    import ws

STEP_ORDER = (
    "start_daemon",
    "health",
    "session",
    "websocket",
    "prompt",
    "wait_done",
    "persist",
)

REQUIRED_ENV = ("HOME", "MIPHAM_BUDGET_TOKENS", "DEEPSEEK_API_KEY", "MIPHAM_DAEMON_PERMISSION")

_DEFAULTS = {
    "MIPHAM_BINARY": "/tmp/mipham/mipham",
    "MIPHAM_PROMPT_PATH": "/logs/agent/mipham-prompt.txt",
    "MIPHAM_RESULT_PATH": "/logs/agent/mipham-result.json",
    "MIPHAM_TRANSCRIPT_PATH": "/logs/agent/mipham-transcript.jsonl",
    "MIPHAM_DRIVER_LOG_PATH": "/logs/agent/mipham-driver.log",
    "MIPHAM_EXEC_TIMEOUT_SEC": "840",
    "MIPHAM_SESSION_PROVIDER": "deepseek",
    "MIPHAM_SESSION_MODEL": "deepseek-v4-pro",
}


class DriverConfigError(Exception):
    """The driver was started without something it cannot invent."""


def driver_env(source: dict[str, str] | None = None) -> dict[str, str]:
    """Resolve the driver's environment, failing loudly on anything required."""
    source = dict(os.environ if source is None else source)
    missing = [key for key in REQUIRED_ENV if not source.get(key)]
    if missing:
        raise DriverConfigError(f"missing required environment: {', '.join(sorted(missing))}")

    env = dict(_DEFAULTS)
    env.update({key: value for key, value in source.items() if key in _DEFAULTS})
    env["HOME"] = source["HOME"]
    env["DEEPSEEK_API_KEY"] = source["DEEPSEEK_API_KEY"]
    env["MIPHAM_BUDGET_TOKENS"] = source["MIPHAM_BUDGET_TOKENS"]
    # Pinned, never inherited: spec §3.4 fixes this to bypassPermissions because
    # the default mode blocks Bash/Write/Edit and every task would fail for a
    # reason that has nothing to do with the model under test.
    env["MIPHAM_DAEMON_PERMISSION"] = "bypassPermissions"
    return env


def _write_result(path: Path, result: dict) -> None:
    """Rewrite the result file. Called on every state change, so a SIGKILL
    (harbor's own agent timeout) leaves the last state on disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def _start_daemon(env: dict[str, str], binary: str, log_path: Path) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as log:
        completed = subprocess.run(
            [binary, "daemon", "start"],
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=180,
            check=False,
        )
    return completed.returncode


def run() -> dict:
    env = driver_env()
    workdir = os.getcwd()
    prompt = Path(env["MIPHAM_PROMPT_PATH"]).read_text(encoding="utf-8")
    budget = int(env["MIPHAM_BUDGET_TOKENS"])
    deadline_sec = float(env["MIPHAM_EXEC_TIMEOUT_SEC"]) - 20.0

    result: dict = {
        "schemaVersion": 1,
        "status": "started",
        "error": None,
        "workdir": workdir,
        "budgetTokens": budget,
        "usage": {"inputTokens": 0, "outputTokens": 0},
        "sessionCounters": None,
        "turns": 0,
        "toolResults": {"total": 0, "errors": 0},
        "stopReason": None,
        "binaryPath": env["MIPHAM_BINARY"],
        "binaryVersion": None,
        "binarySha256": None,
        "sessionId": None,
    }
    result_path = Path(env["MIPHAM_RESULT_PATH"])
    transcript_path = Path(env["MIPHAM_TRANSCRIPT_PATH"])
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    _write_result(result_path, result)

    if budget <= 0:
        # The job-level ledger has nothing left; the honest move is to record
        # that this task was never attempted, not to run it unbounded.
        result["status"] = "budget_exceeded"
        _write_result(result_path, result)
        return result

    started = time.monotonic()
    connection = None
    state = protocol.TurnState()
    try:
        version = subprocess.run(
            [env["MIPHAM_BINARY"], "--version"], capture_output=True, text=True, timeout=60, check=False
        )
        result["binaryVersion"] = (version.stdout or version.stderr or "").strip() or None
        digest = subprocess.run(
            ["sha256sum", env["MIPHAM_BINARY"]], capture_output=True, text=True, timeout=60, check=False
        )
        result["binarySha256"] = (digest.stdout or "").split()[0] if digest.stdout else None

        code = _start_daemon(env, env["MIPHAM_BINARY"], Path(env["MIPHAM_DRIVER_LOG_PATH"]))
        if code != 0:
            result["status"] = "daemon_start_failed"
            result["error"] = f"`daemon start` exited {code}"
            return result

        port = client_module.read_port(env["HOME"])
        daemon = client_module.DaemonClient(port)
        daemon.wait_until_ready()

        session_id = daemon.create_session(
            name="mipham-code-t2",
            cwd=workdir,
            provider=env["MIPHAM_SESSION_PROVIDER"],
            model=env["MIPHAM_SESSION_MODEL"],
        )
        result["sessionId"] = session_id
        result["status"] = "session_created"
        _write_result(result_path, result)

        # §3.3 step ④ before ⑤: see StepOrderTest for why.
        connection = ws.WsConnection.connect("127.0.0.1", port, f"/api/v1/sessions/{session_id}/stream")
        daemon.prompt(session_id, prompt)
        result["status"] = "running"
        _write_result(result_path, result)

        with transcript_path.open("a", encoding="utf-8") as transcript:
            while True:
                if time.monotonic() - started > deadline_sec:
                    # Guarded, like the `done` branch below: the statuses are
                    # not interchangeable. `budget_exceeded` is a disclosed
                    # overspend (spec §六) and exits 0; `deadline_exceeded` is
                    # infrastructure. Overwriting one with the other hides the
                    # disclosure and flips the exit code to 1.
                    if result["status"] == "running":
                        result["status"] = "deadline_exceeded"
                    connection.send_text(json.dumps({"type": "interrupt", "sessionId": session_id}))
                    break
                raw = connection.recv_text()
                if raw is None:
                    # Same guard, same reason: `done` may never arrive (worker
                    # crashed, socket dropped), and a closed stream must not
                    # relabel a run we already stopped for budget.
                    if result["status"] == "running":
                        result["status"] = "stream_closed"
                    break
                message = protocol.reduce_message(state, raw)
                transcript.write(raw + "\n")
                transcript.flush()  # survive a SIGKILL from harbor's agent timeout

                result["usage"] = {
                    "inputTokens": state.input_tokens,
                    "outputTokens": state.output_tokens,
                }
                result["turns"] = state.turns
                result["toolResults"] = {"total": state.tool_results, "errors": state.tool_errors}
                result["stopReason"] = state.stop_reason

                if message["type"] == protocol.USAGE and state.total_tokens > budget:
                    # spec §六: over the ceiling means interrupt and disclose,
                    # never keep spending because the task looks close to done.
                    result["status"] = "budget_exceeded"
                    connection.send_text(json.dumps({"type": "interrupt", "sessionId": session_id}))
                if message["type"] == protocol.DONE:
                    # The completion criterion is the `done` frame and nothing
                    # else (spec §3.3). `state.finished` is also set by an
                    # `error` frame (protocol.py:77), and the daemon broadcasts
                    # `error` *and then* `done` (session-worker.ts:164, :197) —
                    # breaking on `finished` stops one frame early, loses the
                    # turn the `done` would have counted, and swallows the
                    # daemon's error text.
                    if result["status"] == "running":
                        result["status"] = "done"
                    break
                _write_result(result_path, result)

        # The daemon's own persisted counters are an independent reading of the
        # same quantity (daemon/types.ts:19-20). Recording both means a
        # divergence is visible instead of being resolved in our favour.
        try:
            result["sessionCounters"] = daemon.session(session_id)
        except client_module.DaemonError as exc:
            result["sessionCounters"] = {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — the result file is the report
        result["status"] = result["status"] if result["status"] != "started" else "failed"
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if connection is not None:
            connection.close()
        # The daemon's error frame is the only place its failure text exists;
        # without this an errored run is recorded with `error: null`. It never
        # overwrites an existing value, so a more specific exception raised on
        # our side keeps priority.
        if result["error"] is None and state.last_error:
            result["error"] = state.last_error
        result["elapsedSec"] = round(time.monotonic() - started, 3)
        _write_result(result_path, result)
    return result


def main() -> int:
    result = run()
    print(json.dumps({k: v for k, v in result.items() if k != "sessionCounters"}, indent=2))
    return 0 if result["status"] in {"done", "budget_exceeded"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_driver_main -v`
Expected: PASS —— **测试数不写进验收槽位，以 `unittest` 实跑输出为准。**
原文写「6 个测试」，是照本 Step 1 代码块里的用例数推演出来的**预测值**；而落地文件
（`grep -c 'def test_' benchmarks/test/test_driver_main.py`）是 **10** ——
差额来自后续修复轮补的守卫位点用例（`budget_exceeded` 不被 `stream_closed` / `deadline_exceeded`
改写各一条、`error` 帧被披露一条），逐条有理由，不是超范围发挥。
把一个推演值放进验收槽位，会让「实测与它不一致」被读成缺陷 —— 要修的是这个**槽位形态**，不是那个数。

- [ ] **Step 5: 提交**

```bash
git add benchmarks/harbor/driver/main.py benchmarks/test/test_driver_main.py
git commit -m "feat(bench): driver 七步主线 —— 顺序、上限、增量落盘（T2 Plan B 第 8 件）

七步必须在同一个进程里：HOME 决定 daemon 的端口/pid/token/db 位置，
拆成多次 shell 调用的话，漏传一次 HOME 就会让后一次调用看不见前一次
起的 daemon。

WS 必须早于 prompt（测试钉住的不是风格）：getOrCreateWorker 会把此刻
已在 wsClients 里的客户端注册进 worker，先发 prompt 就是往虚空里流，
而那就没有 done —— 表现为挂死。

transcript 每帧 flush、result 每次状态变迁重写：这样 harbor 的 agent
timeout 打死 driver 时，盘上仍有已完成的部分。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: 适配器 `install()` —— 预编译二进制

**Files:**

- Create: `benchmarks/harbor/mipham_code.py`
- Test: `benchmarks/test/test_adapter.py`

**Interfaces:**

- Consumes: **Task 8 的 `benchmarks/harbor/driver/main.py`** —— 具体是它的 `main.REQUIRED_ENV`
  （`driver_env()` 的契约就是「返回值必须覆盖它」，见下）与 `main.MIPHAM_*` 环境键名约定。
  **原文写「无」是假的**：本任务的 `test_adapter.py` 与 Step 3 都依赖这个 import
  （落地：`from benchmarks.harbor.driver import main as driver_main`，测试按
  `set(driver_main.REQUIRED_ENV) - supplied` 断言，**不抄键名**）；
  而 `Consumes` 是派发时唯一告知「本任务依赖谁」的字段 —— 写「无」会让人跳过那个 import 而**今天照样全绿**。
- Produces:
  - `mipham_code.MiphamCodeOptions(InstalledAgentOptions)`（空）
  - `mipham_code.MiphamCode(BaseInstalledAgent)`，类属性：
    - `_BINARY_URL: str`、`_BINARY_PATH: str`、`_DRIVER_DIR: str`、`_PROMPT_PATH: str`
    - `_RESULT_FILENAME`、`_TRANSCRIPT_FILENAME`、`_DRIVER_LOG_FILENAME`
  - `MiphamCode.name() -> str` = `"mipham-code"`
  - `MiphamCode.install(environment: BaseEnvironment) -> None`
  - `MiphamCode.driver_env() -> dict[str, str]`（本任务先建，Task 10 用）—— **契约：返回值必须覆盖 `driver/main.py` 的 `main.REQUIRED_ENV`**。四键里 `HOME` / `DEEPSEEK_API_KEY` / `MIPHAM_DAEMON_PERMISSION` 由本方法给全，`MIPHAM_BUDGET_TOKENS` 由 Task 10 的 `run()` 按当轮余额补（`env["MIPHAM_BUDGET_TOKENS"] = str(ledger.remaining())`）。**读者在 Task 8 会缺键即抛**（`DriverConfigError`），所以漏掉任意一键的后果不是某一题失败，而是**每一题**在容器里起步前就失败

- [ ] **Step 1: 写失败的测试**

```python
# benchmarks/test/test_adapter.py
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor import mipham_code
from benchmarks.harbor.driver import main as driver_main


class ModuleShapeTest(unittest.TestCase):
    def test_name_is_set(self):
        self.assertEqual(mipham_code.MiphamCode.name(), "mipham-code")

    def test_options_model_is_declared(self):
        # Without this, `harbor agent schema` refuses the agent outright:
        # "Agent 'mipham-code' does not declare an options_model".
        self.assertIsNotNone(mipham_code.MiphamCode.options_model)

    def test_the_binary_url_is_pinned_to_a_release_tag(self):
        # `releases/latest` would silently change the artifact under a
        # published score; the whole point of the results file is that it
        # names a version someone else can reinstall.
        self.assertIn("/releases/download/v", mipham_code.MiphamCode._BINARY_URL)
        self.assertNotIn("/latest/", mipham_code.MiphamCode._BINARY_URL)

    def test_the_binary_lands_somewhere_an_agent_user_can_write(self):
        # exec_as_agent runs as the agent user; /usr/local/bin is not
        # guaranteed writable, /tmp always is.
        self.assertTrue(mipham_code.MiphamCode._BINARY_PATH.startswith("/tmp/"))

    def test_the_driver_directory_is_under_the_agent_logs(self):
        self.assertTrue(mipham_code.MiphamCode._DRIVER_DIR.startswith("/logs/agent/"))


class InstallCommandTest(unittest.TestCase):
    def test_install_downloads_the_binary_and_runs_its_version(self):
        command = mipham_code.MiphamCode.install_command()
        self.assertIn(mipham_code.MiphamCode._BINARY_URL, command)
        self.assertIn(mipham_code.MiphamCode._BINARY_PATH, command)
        self.assertIn("--version", command)
        self.assertNotIn("install.sh", command)


class DriverEnvContractTest(unittest.TestCase):
    """The one seam where two tasks must agree, checked where it is free.

    ``driver/main.py`` (Task 8) raises ``DriverConfigError`` when any key of
    ``REQUIRED_ENV`` is missing, and ``run()`` (Task 10) hands it whatever
    ``driver_env()`` returned. Nothing else in the suite covers that seam, so
    without these two tests the first thing to notice a missing key is a paid
    trial — every task fails, for a reason that has nothing to do with the
    model under test.
    """

    def _agent(self, **extra: str) -> mipham_code.MiphamCode:
        # logs_dir is the only required constructor argument; model_name=None
        # makes _init_model_info() return early, so this touches no registry
        # and no network. extra_env is the same slot `--ae` fills.
        env = {"DEEPSEEK_API_KEY": "placeholder"}
        env.update(extra)
        return mipham_code.MiphamCode(
            logs_dir=Path(tempfile.mkdtemp()), extra_env=env
        )

    def test_driver_env_supplies_every_key_the_driver_requires(self):
        supplied = set(self._agent().driver_env())
        missing = set(driver_main.REQUIRED_ENV) - supplied
        # MIPHAM_BUDGET_TOKENS is the one key run() adds from the live ledger
        # balance, so it is legitimately absent here. Asserting the *exact*
        # difference — not a subset — means a fifth required key added later
        # fails this test instead of a paid trial.
        self.assertEqual(missing, {"MIPHAM_BUDGET_TOKENS"})

    def test_the_permission_tier_is_pinned_and_not_merely_hoped_for(self):
        # spec §3.4 fixes bypassPermissions: the default mode blocks Bash and
        # Write, and every task would then fail for a reason unrelated to the
        # model. The driver pins it too (driver/main.py driver_env), but the
        # adapter must supply it — REQUIRED_ENV demands it.
        self.assertEqual(
            self._agent().driver_env()["MIPHAM_DAEMON_PERMISSION"],
            "bypassPermissions",
        )

    def test_the_ae_channel_can_still_override_the_tier(self):
        # --ae is the only documented tuning channel; a pin that ignores it
        # would make the env var look supported while doing nothing.
        self.assertEqual(
            self._agent(MIPHAM_DAEMON_PERMISSION="acceptEdits").driver_env()[
                "MIPHAM_DAEMON_PERMISSION"
            ],
            "acceptEdits",
        )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_adapter -v`
Expected: FAIL —— `ImportError: cannot import name 'mipham_code' from 'benchmarks.harbor'`（Python 3.14：父包已存在时不报 `ModuleNotFoundError`；Task 1 实测的报错形状）

- [ ] **Step 3: 写实现**

```python
# benchmarks/harbor/mipham_code.py
"""Harbor adapter for Mipham Code (T2, spec §三).

Route A+: the adapter drives the daemon's REST API inside the task container,
because the daemon binds loopback *inside* the container and a host-side Python
process cannot reach it. One driver process per trial performs all seven steps
of spec §3.3 (see ``driver/main.py`` for why they cannot be split).

Auth is by source address alone — loopback needs no token (spec §3.4). The only
credential is ``DEEPSEEK_API_KEY``, forwarded from the host environment through
``--ae`` and never written to a file, a log, or the results.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class MiphamCodeOptions(InstalledAgentOptions):
    """No adapter-specific knobs.

    Every tunable travels as agent environment (``--ae KEY=VALUE``) read back
    through ``self._get_env`` or ``driver_env``. That is deliberate: an
    undeclared ``-ak`` kwarg is accepted into ``kwargs`` without complaint and
    then silently ignored, so a typo there fails invisibly. Declared anyway
    because ``harbor agent schema`` requires an ``options_model``.
    """


class MiphamCode(BaseInstalledAgent):
    capabilities = AgentCapabilities()
    options_model = MiphamCodeOptions

    _BINARY_URL = (
        "https://github.com/One-Mipham/mipham-code/releases/download/v0.81.7/mipham-linux-x64"
    )
    _BINARY_PATH = "/tmp/mipham/mipham"
    _DRIVER_DIR = "/logs/agent/mipham-driver"
    _PROMPT_PATH = "/logs/agent/mipham-prompt.txt"
    _RESULT_FILENAME = "mipham-result.json"
    _TRANSCRIPT_FILENAME = "mipham-transcript.jsonl"
    _DRIVER_LOG_FILENAME = "mipham-driver.log"

    @staticmethod
    @override
    def name() -> str:
        return "mipham-code"

    @override
    def get_version_command(self) -> str | None:
        return f"{self._BINARY_PATH} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip()

    @staticmethod
    def install_command() -> str:
        """The shell that fetches the prebuilt binary.

        spec §3.2: the prebuilt binary, never ``install.sh`` — on a bare
        Debian the script reported "No runtime detected", installed Bun, and
        then died on ``error: unzip is required to install bun`` without
        getting mipham onto the box at all.
        """
        return (
            "set -euo pipefail; "
            f"mkdir -p {Path(MiphamCode._BINARY_PATH).parent.as_posix()} && "
            f"curl -fsSL {MiphamCode._BINARY_URL} -o {MiphamCode._BINARY_PATH} && "
            f"chmod 0755 {MiphamCode._BINARY_PATH} && "
            f"{MiphamCode._BINARY_PATH} --version"
        )

    def driver_env(self) -> dict[str, str]:
        """Environment for the single ``exec_as_agent`` call that runs the driver.

        The returned dict must cover every key in ``driver/main.py``'s
        ``REQUIRED_ENV`` except ``MIPHAM_BUDGET_TOKENS``, which ``run()`` adds
        from the live ledger balance. The driver raises ``DriverConfigError``
        on a missing key *before* it does anything else, so an omission here
        fails every trial rather than one — and it fails for a reason that has
        nothing to do with the model under test. ``DriverEnvContractTest`` in
        ``benchmarks/test/test_adapter.py`` is what keeps the two ends in step.
        """
        api_key = self._get_env("DEEPSEEK_API_KEY")
        if not api_key:
            raise ValueError(
                "DEEPSEEK_API_KEY is required. Set it on the host or pass it "
                "with --ae DEEPSEEK_API_KEY=..."
            )
        return {
            # HOME decides where the daemon puts its port file, pid file, token
            # and SQLite database. All four land under the 0777, mount-backed
            # /logs/agent, so they come back to the host with the trial.
            "HOME": (EnvironmentPaths.agent_dir / "home").as_posix(),
            "MIPHAM_BINARY": self._BINARY_PATH,
            "MIPHAM_PROMPT_PATH": self._PROMPT_PATH,
            "MIPHAM_RESULT_PATH": (EnvironmentPaths.agent_dir / self._RESULT_FILENAME).as_posix(),
            "MIPHAM_TRANSCRIPT_PATH": (
                EnvironmentPaths.agent_dir / self._TRANSCRIPT_FILENAME
            ).as_posix(),
            "MIPHAM_DRIVER_LOG_PATH": (
                EnvironmentPaths.agent_dir / self._DRIVER_LOG_FILENAME
            ).as_posix(),
            "DEEPSEEK_API_KEY": api_key,
            "MIPHAM_SESSION_PROVIDER": self._get_env("MIPHAM_SESSION_PROVIDER") or "deepseek",
            "MIPHAM_SESSION_MODEL": self._get_env("MIPHAM_SESSION_MODEL")
            or (self.model_name or "deepseek-v4-pro"),
            "MIPHAM_EXEC_TIMEOUT_SEC": self._get_env("MIPHAM_EXEC_TIMEOUT_SEC") or "840",
            # Required by REQUIRED_ENV, so it has to be supplied here: without
            # it the driver raises before its first step and *every* trial
            # fails. --ae can override it; the default is the tier spec §3.4
            # fixes for this benchmark (the default mode blocks Bash/Write).
            "MIPHAM_DAEMON_PERMISSION": self._get_env("MIPHAM_DAEMON_PERMISSION")
            or "bypassPermissions",
        }

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment,
            ("curl", "bash", "ca_certificates", "coreutils", "python3"),
        )
        await self.exec_as_agent(environment, command=self.install_command())
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_adapter -v`
Expected: **6 PASS / 3 ERROR**（`ModuleShapeTest` 5 + `InstallCommandTest` 1 通过；
`DriverEnvContractTest` 3 条 **error**，由 Task 10 的 `run()` 转绿）—— **不是全绿，且这是有意的。**
三条 error 的成因：`DriverEnvContractTest` 必须先实例化 `MiphamCode`（测试里的 `_agent()`）才能断言，
而 `harbor/agents/base.py:354-355` 的 `run` 是 `@abstractmethod`、`BaseInstalledAgent`
（`harbor/agents/installed/base.py:321`）**没有**实现它 ⇒ Step 3 只给 `install()` + `driver_env()`
时实例化会抛 `TypeError: Can't instantiate abstract class MiphamCode without an implementation
for abstract method 'run'`。
**不要为了让本行读起来是绿的，就在 Step 3 里加一个 stub `run()`**：那会让验收断言一个不成立的形状，
且与 Task 10 的 `run()` 合成一个雷（同一个类体里两次定义 `run`，谁胜取决于编辑落点）。
也**不要**把 `DriverEnvContractTest` 挪到 Task 10：那会让 `driver_env()` 在写下它的那个任务里
没有任何测试钉它。**本行的验收判据是「6 PASS / 3 ERROR」，不是「9 PASS」。**
Task 9 落地后的实测读数逐字为：`Ran 9 tests … FAILED (errors=3)`、`EXIT=1`。
以 `unittest` 实跑输出为准。

- [ ] **Step 5: 让 harbor 自己审一遍这个适配器**

Run:

```bash
cd <repo root>
export PYTHONPATH="$PWD"
harbor run -p benchmarks/.datasets/terminal-bench -i circuit-fibsqrt \
  -a 'benchmarks.harbor.mipham_code:MiphamCode' -m 'deepseek/deepseek-v4-pro' \
  --ae DEEPSEEK_API_KEY=placeholder --ae MIPHAM_DAEMON_PERMISSION=bypassPermissions \
  --dry-run
```

Expected: `Dry run OK — 1 trial(s); nothing was run.`

- [ ] **Step 6: 提交**

```bash
git add benchmarks/harbor/mipham_code.py benchmarks/test/test_adapter.py
git commit -m "feat(bench): 适配器 install() 装预编译二进制（T2 Plan B 第 9 件）

spec §3.2：走 prebuilt 二进制不走 install.sh —— 实测 install.sh 在裸
Debian 里先报 No runtime detected、装了 Bun 又死在 unzip is required，
mipham 一个都没装上。

二进制钉 tag v0.81.7（与 apps/cli/package.json 的 version 一致），不用
releases/latest：成绩公布之后 latest 会漂，而结果文件的意义正是「别人
能重装到同一个版本」。装到 /tmp/mipham 而非 /usr/local/bin，因为
exec_as_agent 以 agent 用户跑。

选项模型刻意为空，并写明了为什么（未声明的 -ak 会被收进 kwargs 后
静默忽略）。

driver_env() 补上 MIPHAM_DAEMON_PERMISSION。driver 的 REQUIRED_ENV 要求
它，而缺它的 driver_env() 会让每一题都在容器里起步前抛
DriverConfigError —— 不是失败一题，是失败全部，且失败原因与受测模型毫无
关系；第一次显形会是花钱的那次真跑。同批加 DriverEnvContractTest 把这条
接缝钉住：断言缺的键恰为 run() 按余额补的那一个（用等号不用包含 —— 将来
有人给 REQUIRED_ENV 加第五个键时，红的该是单测而不是付费试题）。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: 适配器 `run()` —— 上传、执行、回读

**Files:**

- Modify: `benchmarks/harbor/mipham_code.py`（**实现 `run`**，并追加 `_upload_driver`、`_upload_prompt`、`_read_result`、`parse_result`、`apply_context`）
- Test: `benchmarks/test/test_adapter.py`（追加一个 `TestCase` 类）

> **本行原先只列四个成员，与同任务的 Interfaces 块（六个）自相矛盾** —— 少 `parse_result`
> 与 `apply_context`，而 Step 3 逐字给出了这两个方法的实现。危害低（实现者照 Step 3 写就会写出来），
> 但一个只读 Files 行的读者会以为只需加四个成员。**以 Interfaces 块为准。**
>
> **「实现 `run`」不是「追加 `run`」**：Task 9 的 Step 3 有意只写 `install()` + `driver_env()`，
> 而 `run` 在 `harbor/agents/base.py:354-355` 是 `@abstractmethod`、`BaseInstalledAgent`
> （`harbor/agents/installed/base.py:321`）没实现它 ⇒ Task 9 的三条 `DriverEnvContractTest`
> 因无法实例化 `MiphamCode` 而 error。**这三条 error 是本任务要关掉的那一笔**，
> 不是「Task 9 漏了一件事」。

**Interfaces:**

- Consumes: `MiphamCode.driver_env()`（Task 9）、`budget.Ledger`（Task 7）
- Produces:
  - `MiphamCode.ledger_path() -> Path`
  - `MiphamCode.parse_result(stdout: str) -> dict`
  - `MiphamCode.apply_context(context: AgentContext, result: dict) -> None`
  - `MiphamCode.run(instruction, environment, context) -> None`

- [ ] **Step 1: 写失败的测试**

```python
# 追加到 benchmarks/test/test_adapter.py（import 段加 AgentContext 与 budget）
from pathlib import Path

from harbor.models.agent.context import AgentContext

from benchmarks import budget
from benchmarks.harbor import mipham_code


class ParseResultTest(unittest.TestCase):
    def test_round_trips_the_driver_json(self):
        parsed = mipham_code.MiphamCode.parse_result('{"status":"done","usage":{"inputTokens":7}}')
        self.assertEqual(parsed["status"], "done")

    def test_an_empty_stdout_is_an_empty_result_not_a_crash(self):
        # A run that died before writing anything still has to produce a
        # results row — that row is the disclosure.
        self.assertEqual(mipham_code.MiphamCode.parse_result(""), {})

    def test_garbage_is_reported_not_swallowed(self):
        with self.assertRaises(ValueError):
            mipham_code.MiphamCode.parse_result("cat: no such file")


class ApplyContextTest(unittest.TestCase):
    def _result(self) -> dict:
        return {
            "status": "done",
            "usage": {"inputTokens": 1234, "outputTokens": 567},
            "turns": 3,
            "toolResults": {"total": 9, "errors": 2},
            "sessionCounters": {"tokenIn": 1234, "tokenOut": 567},
            "binaryVersion": "@miphamai/cli v0.81.7",
            "binarySha256": "deadbeef",
            "budgetTokens": 50_000_000,
            "workdir": "/app",
        }

    def test_tokens_come_from_the_protocol(self):
        context = AgentContext()
        mipham_code.MiphamCode.apply_context(context, self._result())
        self.assertEqual(context.n_input_tokens, 1234)
        self.assertEqual(context.n_output_tokens, 567)

    def test_cost_and_cache_are_left_unset(self):
        # usage carries two totals and no cache-hit split (spec §六), so any
        # number here would be invented.
        context = AgentContext()
        mipham_code.MiphamCode.apply_context(context, self._result())
        self.assertIsNone(context.cost_usd)
        self.assertIsNone(context.n_cache_tokens)

    def test_metadata_carries_what_the_results_file_needs(self):
        context = AgentContext()
        mipham_code.MiphamCode.apply_context(context, self._result())
        self.assertEqual(context.metadata["mipham"]["toolResults"]["errors"], 2)
        self.assertEqual(context.metadata["mipham"]["binarySha256"], "deadbeef")

    def test_missing_usage_leaves_the_tokens_unset_rather_than_zero(self):
        context = AgentContext()
        mipham_code.MiphamCode.apply_context(context, {"status": "budget_exceeded"})
        self.assertIsNone(context.n_input_tokens)


class LedgerPathTest(unittest.TestCase):
    def test_ledger_path_is_inside_the_package(self):
        path = mipham_code.MiphamCode.ledger_path()
        self.assertEqual(path.parent.name, "results")
        self.assertEqual(path.parent.parent.name, "benchmarks")
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `"$BH" -m unittest benchmarks.test.test_adapter -v`
Expected: FAIL —— `AttributeError: type object 'MiphamCode' has no attribute 'parse_result'`

- [ ] **Step 3: 写实现**

```python
# benchmarks/harbor/mipham_code.py —— 追加 import
import json
import contextlib
import os
import tempfile
from pathlib import Path

from benchmarks import budget   # 注意：adapter 由 harbor 导入，故依赖 PYTHONPATH=<repo root>
```

```python
# 追加到 MiphamCode 类内
    _DRIVER_MODULE = "benchmarks.harbor.driver"
    _LEDGER_ENV = "MIPHAM_BENCH_LEDGER"

    @staticmethod
    def ledger_path() -> Path:
        """``benchmarks/results/ledger.json``.

        Resolved from this file's own location rather than the process's cwd:
        harbor imports the adapter from wherever it happens to be running, and
        a cwd-relative path would silently write a *second* ledger — which
        looks exactly like a fresh, unspent budget.
        """
        override = os.environ.get(MiphamCode._LEDGER_ENV)
        if override:
            return Path(override)
        return Path(__file__).resolve().parents[1] / "results" / "ledger.json"

    @staticmethod
    def parse_result(stdout: str) -> dict:
        text = (stdout or "").strip()
        if not text:
            return {}
        try:
            return dict(json.loads(text))
        except json.JSONDecodeError as exc:
            raise ValueError(f"driver produced no parsable result: {text[:200]!r}") from exc

    @staticmethod
    def apply_context(context: AgentContext, result: dict) -> None:
        """Fill AgentContext from the driver's report.

        ``n_cache_tokens`` and ``cost_usd`` stay None on purpose: the WS usage
        frame carries two totals and no cache-hit split, so anything filled in
        there would be invented (spec §六).
        """
        usage = result.get("usage") or {}
        if usage.get("inputTokens") is not None:
            context.n_input_tokens = int(usage["inputTokens"])
        if usage.get("outputTokens") is not None:
            context.n_output_tokens = int(usage["outputTokens"])
        context.metadata = {
            "mipham": {
                "status": result.get("status"),
                "error": result.get("error"),
                "turns": result.get("turns"),
                "stopReason": result.get("stopReason"),
                "toolResults": result.get("toolResults"),
                "sessionCounters": result.get("sessionCounters"),
                "binaryVersion": result.get("binaryVersion"),
                "binarySha256": result.get("binarySha256"),
                "budgetTokens": result.get("budgetTokens"),
                "elapsedSec": result.get("elapsedSec"),
                "workdir": result.get("workdir"),
                "sessionId": result.get("sessionId"),
            }
        }

    async def _upload_driver(self, environment: BaseEnvironment) -> None:
        await environment.upload_dir(
            Path(__file__).resolve().parent / "driver",
            self._DRIVER_DIR,
        )

    async def _upload_prompt(self, environment: BaseEnvironment, instruction: str) -> None:
        """Upload the task text as a file.

        Never interpolate it into a shell command: task instructions contain
        quotes, backticks and newlines, and a quoting bug here would corrupt
        the prompt in a way that still produces a plausible-looking score.
        """
        handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False)
        try:
            with handle:
                handle.write(instruction)
            await environment.upload_file(handle.name, self._PROMPT_PATH)
        finally:
            with contextlib.suppress(OSError):
                os.unlink(handle.name)

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = self.driver_env()
        ledger = budget.Ledger(self.ledger_path())
        env["MIPHAM_BUDGET_TOKENS"] = str(ledger.remaining())

        await self._upload_driver(environment)
        await self._upload_prompt(environment, instruction)

        result: dict = {}
        readable = False
        readback = "cat " + (EnvironmentPaths.agent_dir / self._RESULT_FILENAME).as_posix()
        try:
            # One call, all seven steps: HOME has to be identical for the whole
            # daemon lifetime, and this is the only frame that guarantees it.
            await self.exec_as_agent(
                environment,
                command=f"python3 {self._DRIVER_DIR}/main.py",
                env=env,
                cwd=None,  # harbor discovered the workdir itself (see below)
                timeout_sec=int(env["MIPHAM_EXEC_TIMEOUT_SEC"]),
            )
        finally:
            # The driver rewrites its result on every state change, so even a
            # killed run leaves something to read back. Best effort: never mask
            # the run's own exception.
            with contextlib.suppress(Exception):
                completed = await self.exec_as_agent(environment, command=readback)
                try:
                    parsed = self.parse_result(completed.stdout)
                except (ValueError, TypeError) as exc:
                    # A truncated write looks exactly like "the driver never
                    # wrote anything" once the suppress swallows it, and this
                    # file is the only disclosure the paid run leaves behind.
                    # TypeError as well as ValueError: valid JSON that is not an
                    # object (e.g. "[1,2]") makes parse_result's dict() raise
                    # TypeError, which would otherwise slip past this branch and
                    # be swallowed into the very ambiguity it exists to remove.
                    result = {"error": f"unreadable driver result: {exc}"}
                else:
                    result = parsed
                    # A non-empty report means the driver accounted for itself;
                    # an empty readback means it never got that far.
                    readable = bool(parsed)
            # remaining() is the ceiling's only enforcement point and Task 13
            # audits the ledger arithmetically, so a 0 recorded because nothing
            # could be read must not be written the same way as a 0 the driver
            # actually reported. A real session id stays the bare note -- Task 13
            # joins ledger entries to trials through it.
            note = str(result.get("sessionId") or "")
            if not note:
                note = "no-session" if readable else "spend-unknown"
            result["ledgerNote"] = note
            with contextlib.suppress(Exception):
                ledger.record(
                    (result.get("usage") or {}).get("inputTokens", 0)
                    + (result.get("usage") or {}).get("outputTokens", 0),
                    note=note,
                )

        self.apply_context(context, result)
```

> **`spend-unknown` 是「0 不是读数」的标记 —— Task 13 必须数它。** 台账记的是 `usage` 里的
> 两个总数之和；**读不到结果时那个 0 不是读数**，所以这里不是记 0 就完事，而是把
> `ledgerNote` 分成三种：真 session id（Task 13 靠它把台账条目与 trial 对上）、
> `no-session`（读到了报告，报告里就是没有 session）、`spend-unknown`（**什么都没读到**）。
> 第三种是上限唯一会**静默放宽**的方向 —— 上限的用途是封顶，误差必须偏「多算」。
> **Task 13 Step 3 的披露义务（判据 4）**：数 `spend-unknown` 的条数，> 0 时必须在披露里写明
> 「这几个 0 不是读数，上限被高估 `条目数 × 该题预算` 量级」。**不要**把 `tokens` 字段改成最坏情况
> —— 那会把「实际花费」这个语义换掉，是另一件事（登记 #15）。

> **`cwd=None` 是对的，但不够。** `environments/base.py` 的 `_upload_environment_dir_after_start` 已经替 harbor 发现过 workdir（`task_env_config.workdir`，为空时跑 `pwd`），而 terminal-bench 与 SWE-bench 的 `task.toml` **都没有 `[environment] workdir`** ⇒ 发现结果是容器内 `pwd`。adapter 拿不到那个值，所以 driver 在容器里读 `os.getcwd()` —— 第 8 件已经这么做。`cwd=None` 表示「继承 harbor 的默认工作目录」，即同一个目录。**Task 12 的集成门必须实测这一点**（见该任务的断言）。

- [ ] **Step 4: 跑测试，确认通过**

Run: `"$BH" -m unittest benchmarks.test.test_adapter -v`
Expected: PASS —— **测试数不写进验收槽位，以 `unittest` 实跑输出为准。**
原文写「13 个测试」是**推演值**：`ModuleShapeTest` 5 + Task 10 的 8 = 13，**漏了**
`InstallCommandTest` 1 与 `DriverEnvContractTest` 3。计划内部当时就有两个互斥的数
（Task 9 Step 4 写 9、本行写 13，而 9 已含那 4 条）。Task 10 交回时的实测读数是
**17 = 9 + 8**；此后修复轮又补了用例，所以「今天这个文件里有几条」**不是**本行的验收判据。
**判据只有一条：全部 PASS。** 把一个推演值放进验收槽位，会让「实测与它不一致」被读成缺陷 ——
要修的是这个**槽位形态**，不是那个数。

- [ ] **Step 5: 提交**

```bash
git add benchmarks/harbor/mipham_code.py benchmarks/test/test_adapter.py
git commit -m "feat(bench): 适配器 run() 上传 driver、执行、回读结果（T2 Plan B 第 10 件）

题面走 upload_file 而不是拼进 shell：任务指令里有引号、反引号和换行，
在这里出 quote bug 会产出一个「看起来合理」的错误成绩。

cost_usd 与 n_cache_tokens 一律留 None —— usage 只给两个总数、没有
cache 命中拆分，填上去就是编造（spec §六）。

台账路径从本文件位置解析而非 cwd：harbor 从任意目录导入适配器，
cwd 相对路径会静默写出第二本台账，而那看起来正是一份没花过的预算。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: 复现脚本与结果装配

**Files:**

- Create: `benchmarks/run-benchmark.sh`
- Create: `benchmarks/results/README.md`（结果目录的说明，一句话）
- Test: 无单元测试（脚本的正确性由 Task 12/13 的真实运行证明；本任务只做 `--help`/语法检查）

**Interfaces:**

- Consumes: `benchmarks/tasks.py` CLI（Task 6）、`benchmarks/budget.py` CLI（Task 7）、`benchmarks/harbor/mipham_code.py`（Task 9/10）
- Produces:
  - `benchmarks/run-benchmark.sh --phase 1|2 [--fresh] [--tasks-only]`
  - 环境变量：`MIPHAM_BENCH_LEDGER`（台账路径）、`MIPHAM_BENCH_PYTHON`（解释器）、`MIPHAM_LEDGER_CEILING`（Phase 2 用）
  - 作业结果 `benchmarks/jobs/<phase>/`、汇总 `benchmarks/results/phase<N>-<dataset>.json`

- [ ] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# Reproduce one phase of the T2 benchmark run.
#
# Two network dependencies, deliberately kept apart:
#   * the dataset comes from github.com and needs a local proxy on this host —
#     the proxy is set on that one command, below, and nowhere else;
#   * the model runs inside the container against api.deepseek.com, which is
#     reachable from the mainland directly (measured: TLS 1.3, 0.96s). Harbor
#     never fetches the dataset during the run because we hand it -p <dir>.
set -euo pipefail

PHASE=""
FRESH=0
TASKS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --phase) [ $# -ge 2 ] || { echo "usage: $0 --phase 1|2 [--fresh] [--tasks-only]" >&2; exit 2; }; PHASE="$2"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --tasks-only) TASKS_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# These two dataset ids are copies of `benchmarks/tasks.py`'s PHASE1_DATASET /
# PHASE2_DATASET (:18/:19), and `DATASET` is what gets asserted against the
# recorded selection and written to the archive -- so a drift here would not be
# a cosmetic mismatch. They belong to the module; read them from it:
#
#   DATASET="$("$PYTHON" -c "from benchmarks import tasks; print(tasks.PHASE${PHASE}_DATASET)")"
#
# Same for the ledger ceiling below. **State of the landed artifact** (2026-09-17):
# `benchmarks/run-benchmark.sh:25`/`:26` and `:108`/`:110` **still write the
# literals**. `A 表第 11 行` asked for this and it was not closed -- recorded
# here as what the artifact is, **not** as "already taken from the module".
case "$PHASE" in
  1) DATASET="terminal-bench@2.0";  DATASET_DIR_NAME="terminal-bench";     RULE="first";       N=10; EXEC_TIMEOUT=840  ;;
  2) DATASET="swebench-verified@1.0"; DATASET_DIR_NAME="swebench-verified"; RULE="first-repos"; N=10; EXEC_TIMEOUT=2940 ;;
  *) echo "usage: $0 --phase 1|2 [--fresh] [--tasks-only]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH="$REPO_ROOT/benchmarks"
DATASETS="$BENCH/.datasets"
JOBS="$BENCH/jobs/phase$PHASE"
RESULTS="$BENCH/results"
DATASET_DIR="$DATASETS/$DATASET_DIR_NAME"
LEDGER="${MIPHAM_BENCH_LEDGER:-$RESULTS/ledger.json}"
PROXY="${MIPHAM_BENCH_PROXY:-http://127.0.0.1:7897}"

# The adapter imports harbor, so every Python here has to run under an
# interpreter that can import it. Find one instead of assuming.
PYTHON="${MIPHAM_BENCH_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for candidate in python3 "$HOME/.local/share/uv/tools/harbor/bin/python"; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import harbor' >/dev/null 2>&1; then
      PYTHON="$candidate"; break
    fi
  done
fi
[ -n "$PYTHON" ] || { echo "no interpreter on this host can import harbor" >&2; exit 1; }
export PYTHONPATH="$REPO_ROOT${PYTHONPATH:+:$PYTHONPATH}"

echo "phase=$PHASE dataset=$DATASET runner=$PYTHON"

# ── 1. dataset (proxy here, and only here) ──────────────────────────────────
if [ ! -d "$DATASET_DIR" ]; then
  mkdir -p "$DATASETS"
  HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" \
    harbor datasets download "$DATASET" -o "$DATASETS"
fi

# ── 2. selection: recomputed from the download, asserted against the record ──
# Read the list through a file rather than `mapfile`: that builtin is bash 4+,
# and the bash on this host is 3.2.57. `set -e` still propagates the assertion.
# **Host prerequisite: this loop has to run under bash 3.2** -- `mapfile` dies
# with `command not found` (exit 127) before any selection logic is reached, so
# the failure would say nothing about the selection.
SELECTION="$(mktemp)"
trap 'rm -f "$SELECTION"' EXIT
"$PYTHON" -m benchmarks.tasks \
  --dataset-dir "$DATASET_DIR" --rule "$RULE" --n "$N" --expect-recorded > "$SELECTION"
TASKS=()
while IFS= read -r task; do
  if [ -n "$task" ]; then TASKS+=("$task"); fi
done < "$SELECTION"
[ "${#TASKS[@]}" -eq "$N" ] || { echo "expected $N tasks, got ${#TASKS[@]}" >&2; exit 1; }
INCLUDE=()
# ⚠️ **The three array expansions in this section share one guard** -- this one,
# the `printf` below, and `"${INCLUDE[@]:-}"` in step 4. Two of them are covered
# by `:-` today and this one is not, but the line above asserts `#TASKS[@] == N`
# and exits 1 first, so under the current call shape this one is unreachable
# either way. **If a future phase ever takes N == 0**, fix this line too -- and
# then use `${TASKS[@]+"${TASKS[@]}"}`, **not `:-`**: `:-` injects one empty word
# into the expansion (measured on bash 3.2.57), which would send `-i ""` to
# `harbor run` and turn a loud `exit 1` into a junk call.
for task in "${TASKS[@]}"; do INCLUDE+=(-i "$task"); done
printf 'tasks: %s\n' "${TASKS[*]:-}"

# ── 3. ledger ───────────────────────────────────────────────────────────────
# The ceiling is not retyped here. `benchmarks/budget.py:18` owns the value
# (`DEFAULT_CEILING = 50_505_050`); a second copy written here would be the same
# number in a shape grep cannot pair with the original (`50505050`, no
# underscores). Ask the module:
CEILING="${MIPHAM_LEDGER_CEILING:-$("$PYTHON" -c 'from benchmarks import budget; print(budget.DEFAULT_CEILING)')}"
# Passing `--ceiling` explicitly means `budget.py:79`'s own default never gets a
# chance to apply, so this variable is the only place the value is decided.
if [ "$FRESH" -eq 1 ]; then
  "$PYTHON" -m benchmarks.budget --path "$LEDGER" init --ceiling "$CEILING" --fresh
else
  "$PYTHON" -m benchmarks.budget --path "$LEDGER" init --ceiling "$CEILING"
fi
"$PYTHON" -m benchmarks.budget --path "$LEDGER" show

# ── 4. the run ──────────────────────────────────────────────────────────────
if [ "$TASKS_ONLY" -eq 0 ]; then
  : "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set in the host environment}"
  # The adapter resolves that path from its own process environment
  # (`mipham_code.ledger_path()` reads `os.environ`). The --ae line below goes
  # to the *container*, where nothing reads it -- the driver's REQUIRED_ENV does
  # not list the key -- so it cannot be the channel. Without this export the two
  # sides agree only by coincidence: the script's default and the adapter's
  # fallback are two independently written expressions that happen to spell the
  # same file today. Were they ever to diverge, the ceiling would silently stop
  # biting -- every task would get the full budget -- while the archive still
  # read as "nothing was spent".
  export MIPHAM_BENCH_LEDGER="$LEDGER"
  mkdir -p "$JOBS"
  harbor run \
    -p "$DATASET_DIR" \
    "${INCLUDE[@]:-}" \
    -a 'benchmarks.harbor.mipham_code:MiphamCode' \
    -m 'deepseek/deepseek-v4-pro' \
    -n 1 -k 1 \
    -o "$JOBS" --job-name "phase$PHASE" \
    --ae "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY" \
    --ae MIPHAM_DAEMON_PERMISSION=bypassPermissions \
    --ae "MIPHAM_EXEC_TIMEOUT_SEC=$EXEC_TIMEOUT" \
    --ae "MIPHAM_BENCH_LEDGER=$LEDGER" \
    -y
fi

# ── 5. assembly ─────────────────────────────────────────────────────────────
# Guarded on the same flag as step 4: with --tasks-only there are no trials to
# assemble, and an archive written under this name would be a 0-trial file
# wearing the deliverable's exact name. `results/` is not gitignored and Task 13
# Step 4 adds the whole directory, so that file would be committed as the
# phase's record if a real run later failed and left it on disk.
if [ "$TASKS_ONLY" -eq 0 ]; then
"$PYTHON" - "$JOBS" "$RESULTS/phase$PHASE-${DATASET%%@*}.json" "$LEDGER" "$DATASET" <<'PY'
import json, sys
from pathlib import Path

# argv[1]/[2]/[3] map to jobs root / output path / ledger path, one for one.
# The dataset id is a *fourth* argument: it is not derivable from any of the
# three above (argv[2] is an output path), and writing that path into the
# archive's own `dataset` field made the file lie about which dataset it holds.
jobs_dir, out_path, ledger_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
ledger = json.loads(Path(ledger_path).read_text()) if Path(ledger_path).exists() else {"ceiling": None, "entries": []}

rows = []
for result_file in sorted(jobs_dir.rglob("mipham-result.json")):
    trial_dir = result_file.parent.parent
    rows.append({"trial": trial_dir.name, "result": json.loads(result_file.read_text())})

total_in = sum((r["result"].get("usage") or {}).get("inputTokens", 0) for r in rows)
total_out = sum((r["result"].get("usage") or {}).get("outputTokens", 0) for r in rows)
summary = {
    "schemaVersion": 1,
    "dataset": sys.argv[4],
    "trials": rows,
    "totals": {
        "inputTokens": total_in,
        "outputTokens": total_out,
        "tokens": total_in + total_out,
        "budgetExceededTasks": sum(1 for r in rows if r["result"].get("status") == "budget_exceeded"),
        "completedTasks": sum(1 for r in rows if r["result"].get("status") == "done"),
    },
    "ledger": ledger,
}
out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(json.dumps(summary, indent=2) + "\n")
print(f"wrote {out_path}: {len(rows)} trials, {total_in + total_out} tokens")
PY
fi
```

> **这条配方会把 `DEEPSEEK_API_KEY` 的值放进宿主 `harbor run` 的 argv（登记 #19）。** 已知、有界：
> 本机是单用户工作站，威胁面是「同机其它用户 `ps`」。**保留它**，理由三条：(a) 本轮真跑在即，
> 换通道就是换一条 Task 12/13 依赖的运行配方；(b) 威胁面有界；(c) 替代通道的语义当时未验 ——
> 用一个没验过的通道替一条已知形状的通道，是把「有界的已知暴露」换成「未知形状的暴露」。
>
> **替代通道 `--env-file` 的语义（已测，但只测到函数级，端到端「未验」）**：
> `harbor run --help` 原文是 `Path to a .env file to load into environment.`，而
> `harbor/cli/jobs.py:1439-1443` 收到的 `--env-file` 走的是 `load_dotenv(env_file, override=True)`
> ⇒ 它进的是**宿主 CLI 进程的 `os.environ`**，**不是容器**；`jobs.py:2136-2138` 的
> `explicit_env_file_keys`（`:223` 用来免掉宿主环境确认提示）是同一结论的第二处证据。
> **本轮实测读数**（`/tmp/t18_envfile_probe.py`，直接调 harbor 自己的两个函数，不跑 `harbor run`）：
> `load_dotenv` 前 key 不在 `os.environ`、后在其中；agent 那一段仍要靠
> `--ae 'DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}'`（**单引号**，让模板而不是宿主 shell 展开）+
> `resolve_env_vars()` 取值（实测解析结果与宿主值相等）。⇒ 可行的形态是
> **`--env-file <仓外 0600 文件>` + `--ae '<KEY>=${<KEY>}'`**，argv 里只剩**名字**。
> **两个「未验」必须写清楚**：(1) 端到端未跑（跑 `harbor run` 是禁止的，`--dry-run` 是它的子命令
> 所以同样不可用）；(2) 「秘密落一个仓外 0600、用完即删的 `.env`」是否可接受，**是一条新判断**
> —— 本仓口径「秘密不入库 = 不进任何 git 仓库」，一个仓外文件不违反它，但也不因此自动成立。
> ⇒ **`:204` 的 `--ae "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY"` 本轮不动**；
> 上面这两条实测只作为将来换通道的起点。
>
> **坐标订正（T18，2026-09-17 就地加）**：本句原写 **`:105`/`:199`**，两处都已**陈旧** ——
> 实测此刻那条 `--ae "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY"` 在 `benchmarks/run-benchmark.sh` 的
> **`:204`**（`:187` 是 `: "${DEEPSEEK_API_KEY:?…}"` 那道读取＋校验；原写的 `:199` 现已是
> `export MIPHAM_BENCH_LEDGER="$LEDGER"`）。**「本轮不动」这个结论不变，变的只是指路的坐标**，
> 指向 `:204`（内容锚点：`--ae "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY" \`）。
>
> **补一条 `--print-config` 的读数（T18 实测，须与上段的两个「未验」并列读）**：
> `--print-config` **不是**子命令，而是与 `--dry-run` 并列的**旗标**（`harbor/cli/jobs.py:424-427`，
> 逐字 `help="Print the resolved JobConfig JSON and exit."`；两者互斥见 `jobs.py:1385-1386`）——
> 上段写的「`--dry-run` 是它的子命令」是**措辞错误**，已按源码订正。它落在 `_execute_job()` 里
> **打印后立即 `return`**（`jobs.py:2002-2013`），位置**在任何 job 目录、容器、网络调用之前**
> ⇒ 它**不产生作业、不花钱、不改任何状态**。
>
> **如实披露**：T18 在早前一轮**用过它三次**（探针 2/3 用的是仓外 0600 的临时 env 文件，已删）——
> 那是「跑了 `harbor run` 的一个旗标」这一事实，记在此处，不辩解；未跑任何 trial。
> **读数**：探针 2/3 打印的 `--ae` 值**未被展开**（逐字打出 `${MIPHAM_T18_PROBE}`）
> ⇒ **`--print-config` 无法判别「值 vs 模板」**，故它**不能**用来验 `--env-file` + `--ae '<KEY>=${<KEY>}'`
> 这条通道 —— 上面那两个「未验」**因此仍然是未验**，不因这次读数升级。

- [ ] **Step 2: 语法检查 + 只跑选题目录（不花钱）**

```bash
cd <repo root>
bash -n benchmarks/run-benchmark.sh
bash benchmarks/run-benchmark.sh --phase 1 --tasks-only
```

Expected: 打印 `phase=1 dataset=terminal-bench@2.0 runner=...`、10 个题名、台账 `ceiling=50505050 remaining=50505050 entries=0`，退出码 0。

- [ ] **Step 3: 提交**

```bash
git add benchmarks/run-benchmark.sh benchmarks/results/README.md
git commit -m "feat(bench): 复现脚本 —— 代理只挂在数据集那一条命令上（T2 Plan B 第 11 件）

两条互相独立的网络依赖刻意分开：数据集来自 github.com、在本机必须
走 127.0.0.1:7897；模型跑在容器里对 api.deepseek.com、国内直连。
做法是数据集先下载、再 -p 交给 harbor run —— 这样代理变量根本不会
渗进容器，两条依赖可以分别披露（spec 自己的原则是「可复现性不该
依赖一条代理链路」）。

解释器不假定：谁 import 得动 harbor 就用谁，并把选中者打出来。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: 集成门 —— 一题真跑通

**Files:**

- Modify: 视结果而定（driver / adapter / 脚本之一）
- Create: `benchmarks/results/integration-gate.json`（这一题的结果记录）

**Interfaces:**

- Consumes: Task 9/10 的 `MiphamCode`（`driver_env()` 的键名与本任务断言逐字对齐）、Task 8 的 `run()` 结果 schema（`status` / `usage` / `workdir` / `sessionCounters` / `binarySha256`）、Task 11 的 `run-benchmark.sh --phase 1`
- Produces: `benchmarks/results/integration-gate.json`，字段 `{schemaVersion, hostArch, dockerPlatform, image, trial, result, driverLogTail}` —— Task 13 Step 3 与 Task 14 的「仪器与平台」一节直接取用；Task 12 Step 3 的定位表**若被触发**，其处置结果也记进该文件

**为什么它是独立任务：** 前十一个任务的单元测试全部绿，只能证明每一块各自成立。这一题要证明的是**它们接得上**：容器里 daemon 起得来、cwd 白名单放行、模型能鉴权、WS 收得到 `done`、token 数落得下来。历史上本仓库反复栽在「两条渲染路径只接一条」，而那种缺陷只有集成层抓得到。

- [ ] **Step 1: 跑一题（最便宜的：`circuit-fibsqrt`）**

```bash
cd <repo root>
export DEEPSEEK_API_KEY=<从本机环境取，绝不写进任何文件>
bash benchmarks/run-benchmark.sh --phase 1 --fresh
```

（把 `--phase 1` 的 10 题改成先只跑 1 题来省钱：临时 `-i circuit-fibsqrt`，或在脚本外手动执行第 4 步的 `harbor run`。**本步骤以手动单题命令为准**，见下面的逐条断言。）

- [ ] **Step 2: 逐条断言（每条都必须由真实产物读出，未读到的格子留空并如实记录）**

```bash
JOB=$(ls -td benchmarks/jobs/phase1/phase1* | head -1)
TRIAL=$(ls -td "$JOB"/* | head -1)
R="$TRIAL/agent/mipham-result.json"
echo "--- driver result ---"; cat "$R"
echo "--- binary identity ---"
python3 -c "import json,sys; r=json.load(open('$R')); print(r['binaryVersion'], r['binarySha256']); assert r['binarySha256'], 'no digest recorded'"
echo "--- tokens ---"
python3 -c "import json; r=json.load(open('$R')); print(r['usage']); assert r['usage']['inputTokens']>0, 'no input tokens: the model was probably never called'"
echo "--- protocol vs daemon ---"
python3 -c "import json; r=json.load(open('$R')); print('ws', r['usage'], 'daemon', r['sessionCounters'])"
echo "--- transcript exists and is non-empty ---"
wc -l "$TRIAL/agent/mipham-transcript.jsonl"
echo "--- daemon state came back with the trial ---"
ls -a "$TRIAL/agent/home/.mipham/" 2>/dev/null || echo "MISSING: HOME was not /logs/agent/home"
echo "--- the working directory the driver actually saw ---"
python3 -c "import json; print(json.load(open('$R'))['workdir'])"
```

**判据（全部要满足）：**

| 断言                                           | 期望 | 读不出来意味着                                                                                        |
| ---------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| `status == "done"`                             | 是   | WS 没收到 `done`；查 `mipham-driver.log`                                                              |
| `binarySha256` 非空                            | 是   | 二进制没装成或 `sha256sum` 不在镜像里                                                                 |
| `usage.inputTokens > 0`                        | 是   | 模型没被调用（多半是鉴权）或 driver 读不到 key                                                        |
| `sessionCounters.tokenIn == usage.inputTokens` | 相等 | 两处读数不一致 —— **照实披露，不许取自己有利的那个**                                                  |
| `mipham-transcript.jsonl` 行数 > 0             | 是   | 流没连上                                                                                              |
| `agent/home/.mipham/daemon.port` 存在          | 是   | `HOME` 没传对                                                                                         |
| `workdir` == 容器里的 `pwd`                    | 是   | cwd 白名单会 403（`benchmarks/jobs/.../agent/mipham-driver.log` 里会写 `403` 与 `trusted workspace`） |

- [ ] **Step 3: 若 `status != "done"`，按这张表定位**

| 症状                                                   | 处置                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 ... trusted workspace`                            | `cwd` 与 daemon 的 `daemonRoot` 不重合。daemon 由 driver 以 `subprocess` 起、**不传 `cwd`** ⇒ 它继承 driver 的 cwd（harbor 给的工作目录），而 session 的 `cwd` 是 `os.getcwd()` —— 两者本该相同。不同则说明 harbor 的默认工作目录与 `pwd` 不一致，此时 driver 改为显式 `subprocess.run(..., cwd=workdir)` 并重跑本任务 |
| `usage.inputTokens == 0` 且 transcript 里有 `error` 帧 | 鉴权。查 `mipham-driver.log` 里 daemon 是否报 provider 未配置；必要时让 driver 在 `$HOME/.mipham/config.yml` 写一份**只含 provider/model/baseUrl、不含密钥**的最小配置（密钥仍走环境变量）                                                                                                                             |
| 一直收不到 `done`，`recv_text` 在阻塞                  | WS 与 prompt 的顺序或 `getOrCreateWorker` 的注册路径。先确认 driver 里 `WsConnection.connect` 在 `daemon.prompt(...)` 之前被调用                                                                                                                                                                                       |
| `daemon_start_failed`                                  | 二进制在这个基础镜像里跑不起来（缺依赖）。`mipham-driver.log` 里有 stderr；把它加进 `ensure_system_dependencies` 的清单                                                                                                                                                                                                |

- [ ] **Step 4: 记录这一题**

```bash
cd <repo root>
python3 - <<'PY'
import json, os, pathlib
# 只记事实：这一题的 driver 结果 + 用的镜像 + 平台
# ⚠️ 写盘那一行必须走 redact（见下）：
# from benchmarks.redact import redact
# out_path.write_text(redact(json.dumps(summary, indent=2) + "\n"))
PY
```

把这一题的 `mipham-result.json`、`agent/mipham-driver.log` 的尾部、以及宿主机 `uname -m` / `docker version --format '{{.Server.Os}}/{{.Server.Arch}}'` 记进 `benchmarks/results/integration-gate.json`。

> **该文件必须由代码产出、且必须经 `benchmarks.redact` —— 不许手写一份 JSON 再 `git add`（登记 #23）。**
> 它不是被忽略的文件（`benchmarks/.gitignore` 只忽略 `jobs/`、`.datasets/`、`results/ledger*`、`__pycache__/`），
> 会进**公开**仓库；而字段集里的 **`driverLogTail`** 是这批字段里**唯一**可能带出密钥形态的一项 ——
> 容器是以 `--ae "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY"` 起的，driver 日志正是在那个环境里产生的，
> 而 `benchmarks/redact.py:25` 的判据类 `(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{8,}` 就是为这类字符串设的
> （**收尾波 C5 已给该判据类加前导边界锚**：未锚的旧形会误啃 `integration_gate.py` 写进**已提交**产物的假 trial 名
> `pallets__flask-5014__…`。本句所指的对象未变，只是那一处的判据类跟着收紧）。
> 形状照 Task 11 的相位归档（一个 heredoc 进来的 python 脚本，`from benchmarks.redact import redact`，
> 最后一行 `out_path.write_text(redact(json.dumps(summary, indent=2) + "\n"))`）。
> **判据（评审可直接读 diff 判）**：diff 里必须存在**一个调用 `redact` 的写点** ——
> 一份纯 JSON 的新增文件**不满足**这条，即使它今天看起来干净。
> **若手边没有能 `import benchmarks.redact` 的解释器**：**停下报告**，不许退回「手写 JSON + `git add`」
> 再在报告里写一句「看起来没有密钥」。
> **这条义务没有自动守卫**（如实写明）：没有任何测试会因为跳过 `redact` 而变红 ——
> 计划没有给本任务任何测试，而被守的文件当时还不存在。兜底只有两条：**照做** + **评审读 diff 核**。

- [ ] **Step 5: 提交**

```bash
git add benchmarks/results/integration-gate.json <若改了代码则一并 add>
git commit -m "test(bench): 集成门 —— 一题真跑通，七步接得上（T2 Plan B 第 12 件）

单测全绿只证明每块各自成立。这一题证明的是接得上：容器里 daemon
起得来、cwd 白名单放行、模型鉴权过了、WS 收得到 done、token 落得
下来、HOME 状态随 trial 回到宿主。

协议累加值与 daemon 自己持久化的计数并列记录，不一致就照实写出来。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 13: Phase 1 正式跑 —— 10 题、50,505,050 token 上限

**Files:**

- Create: `benchmarks/results/phase1-terminal-bench.json`
- Modify: `benchmarks/results/integration-gate.json`（仅在发现与门不同的事实时）

**Interfaces:**

- Consumes: Task 6 的 `tasks.PHASE1_EXPECTED`（10 个题名，脚本会再断言一次）、Task 7 的台账、Task 10 的 adapter、Task 11 的装配段
- Produces: `benchmarks/results/phase1-terminal-bench.json`，字段 `{schemaVersion, dataset, trials:[{trial, result}], totals:{inputTokens, outputTokens, tokens, budgetExceededTasks, completedTasks}, ledger}` —— **Task 15 的校准直接吃 `totals` 与 `trials[].result.usage`**，Task 14 的披露吃同一份，Task 17 Step 3 要拿它与 Phase 2 并列比

- [ ] **Step 1: 确认预算与账本状态**

```bash
cd <repo root>
python3 -m benchmarks.budget --path benchmarks/results/ledger.json show
```

Expected: `ceiling` = `50505050`；若集成门那一题已记过账，`remaining` = 上限减去它。

- [ ] **Step 2: 跑**

```bash
export DEEPSEEK_API_KEY=<本机环境>
bash benchmarks/run-benchmark.sh --phase 1
```

- [ ] **Step 3: 读结果，逐条如实核对**

```bash
python3 - <<'PY'
import json
s = json.load(open('benchmarks/results/phase1-terminal-bench.json'))
print(json.dumps(s['totals'], indent=2))
for row in s['trials']:
    r = row['result']
    print(row['trial'], r['status'], r['usage'], r.get('error'))
PY
```

**必须写进结果文件或 `benchmarks/README.md` 的（缺一不可）：**

- 每题的 `status` 与 token 数（`usage` 是协议事实）
- 触发上限的题数（`budgetExceededTasks`）；若 > 0，写清**中止发生在第几题之后**
- `usage` 与 `sessionCounters` 是否一致；不一致的题逐题列出
- 总 token 数与上限的比值
- 总成本**写成区间**，不是精确值（`usage` 无 cache 命中拆分 —— spec §六）
- **判据 4（台账里的 `spend-unknown` 条数）**：数一遍台账里 `note == "spend-unknown"` 的条数。
  `> 0` 时**必须**在披露里写明「这几个 0 **不是读数**，上限因此被高估 `条目数 × 该题预算` 量级」
  —— 记 0 是上限唯一会**静默放宽**的方向，而上限的用途是封顶（误差必须偏「多算」）。
  `no-session`（读到了报告、报告里没有 session）是另一回事，分开数、不要合并（登记 #15）

- [ ] **Step 4: 提交**

```bash
# 显式路径，不用目录级 `git add benchmarks/results/`：`benchmarks/budget.py`
# 在 `results/` 里造出同族三个运行态文件 —— `ledger.json.lock`（`budget.py:54`
# 创建且永不删除）、`ledger.json.tmp`（`:66`，死在写入与 `os.replace` 之间时会
# 留下含完整台账的副本）、`ledger-phase2.json` —— 而 `.gitignore` 只忽略了
# `results/ledger.json` 这一个名字。目录级 add 会把它们扫进一个**公开**仓库。
git add benchmarks/results/phase1-terminal-bench.json
# 提交前确认没有运行态文件被 stage（零输出才算过）
git status --porcelain | grep -E 'ledger' || echo "ok: no ledger* staged"
git commit -m "docs(bench): Phase 1 Terminal-Bench 10 题结果落盘（T2 Plan B 第 13 件）

结果文件只放机器读数：每题 token 来自 WS usage（协议事实），并与
daemon 自己持久化的计数并列。美元写成区间不写精确值 —— usage 只给
两个总数、没有 cache 命中拆分。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 14: Phase 1 披露与文档

**Files:**

- Create: `benchmarks/README.md`
- Modify: `README.md`（仓库根：加一节「公开基准」，复现命令 + 选题规则 + 五条披露）

**Interfaces:**

- Consumes: Task 13 的 `phase1-terminal-bench.json`（每题 tokens 与成本区间）、Task 12 的 `integration-gate.json`（仪器与平台读数）、Task 6 的选题规则与重算命令、Task 11 的 `run-benchmark.sh`
- Produces: `benchmarks/README.md`（五条披露全文 + 规格分歧四条 + 已知限制）—— Task 18 在它上面**追加** Phase 2 一节，不另起文件；根 `README.md` 只放结论与指向它的链接

- [ ] **Step 1: 写 `benchmarks/README.md`**

内容清单（每条都必须落到文字，不许「见结果文件」一笔带过）：

1. **复现命令**（逐字可粘）：两条网络依赖分开写，代理只出现在数据集那一条；`DEEPSEEK_API_KEY` 只写变量名。
2. **选题规则**：Phase 1 与 Phase 2 各一条，都写明「先于任何结果确定」，并给出 `benchmarks/tasks.py` 的重算命令。
3. **五条强制披露（spec §4.1），一条不落：**
   - ① **scaffold 成绩不是模型裸能力** —— Harbor 提供了容器隔离、工具集、系统依赖；这一分数属于「Mipham Code 在 Harbor scaffold 下」。
   - ② **pass@1 不是 pass@k** —— k=1，没有多次采样的信息。
   - ③ **每任务 tokens 与成本** —— 逐题列出，成本写成区间。
   - ④ **复现命令 + seed** —— 命令见上；seed 如实说明：本轮**没有**设置采样 seed（Harbor 与 provider 均未固定），因此逐题输出不可逐字重放，可复现的是**流程与判据**。
   - ⑤ **模型选型与自家模型摸底** —— 发布模型 `deepseek-v4-pro`（第三方）是**产品判断**：真实基准走成熟模型成绩才可解释，且与自家模型摸底**解耦**。自家模型结论**分成两份**，不许写成「自家模型全不行」：`v5-pro`/`v5-apex` 24 次采样 0 命中且编造工具调用；`v5-flash` 在 31 个真实工具上 3/3 调对。决定因素是**血统不是参数量**。
4. **规格分歧四条**（照抄本计划对应章节）。
5. **仪器与平台**：宿主 `uname -m`、Docker 平台、harbor 版本、Mipham Code 二进制版本 + `sha256`、容器基础镜像清单。
6. **已知限制**：`n_cache_tokens`/`cost_usd` 未填因为协议不提供；pass@1；单机单次；SWE-bench 阶段的 x86 模拟（Phase 2 补写）。

- [ ] **Step 2: 在仓库根 `README.md` 加一节**

根 README 只放：一句结论 + 结果文件路径 + 复现命令 + 指向 `benchmarks/README.md` 的链接。五条披露**全文在 `benchmarks/README.md`**，根 README 不复制（复制出来的那份一定会先腐烂 —— 本仓库「假主张要按拷贝修」的教训）。

- [ ] **Step 3: 提交**

```bash
git add benchmarks/README.md README.md
git commit -m "docs(bench): Phase 1 披露 —— 五条强制披露一条不落（T2 Plan B 第 14 件）

披露全文只在 benchmarks/README.md，根 README 只放结论与链接：抄成
两份的那一份一定会先腐烂。

第五条按实测拆成两份写：v5-pro/v5-apex 24 次采样 0 命中且编造，
v5-flash 31 个真实工具 3/3 调对 —— 写成「自家模型全不行」是假的。

seed 一栏如实写「本轮未固定」：可复现的是流程与判据，不是逐字输出。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

# Phase 2 — SWE-bench Verified（`swebench-verified@1.0`，500 题，取 10 个仓库各一题）

---

### Task 15: Phase 2 校准 —— 用真 `usage` 定上限

**Files:**

- Create: `benchmarks/results/phase2-calibration.json`
- Modify: `benchmarks/run-benchmark.sh`（若校准暴露出脚本需要参数化）

**Interfaces:**

- Consumes: **`benchmarks/results/phase1-terminal-bench.json`** —— 具体是 `totals.budgetExceededTasks` 与每个 `trials[].result.usage.{inputTokens,outputTokens}`（被中止的题**也在内**，理由见 Step 1 的规则）
- Produces: `benchmarks/results/phase2-calibration.json`，字段 `{schemaVersion, basis, rule, ceiling, derivation, note}` —— **Task 17 Step 1 读其中的 `ceiling`** 作为 `MIPHAM_LEDGER_CEILING`

**为什么这不是占位符：** spec §六 自己写了「**回访触发：第一轮真 `usage` 出来后校准第二轮的 token 上限**」。用户 2026-09-16 明确选了「先 T-Bench，用真 usage 校准后再给 SWE-bench 定档」。所以 Phase 2 的上限**本就该**在 Phase 1 数据到手之后才存在。

- [ ] **Step 1: 从 Phase 1 读数算出 Phase 2 的上限**

```bash
cd <repo root>
# 规则句是权威，而它**自己那段脚本没有实现它**（三处，见下面的规则段）⇒ 实现按规则句改，
# 并落进仓库，好让「这个数怎么算出来的」可被独立重跑，而不是只留一句自述。
python3 benchmarks/calibrate-phase2.py            # 打印 derivation 子树
python3 benchmarks/calibrate-phase2.py --check    # 与已提交的产物逐字段比；不一致则非零退出
```

**规则（写进 `benchmarks/results/phase2-calibration.json`，含上面脚本的原始输出）：** 上限 = 10 ×（Phase 1 已完成题目的**每题材 token 中位数与均值中的较大者**，向上取整到 10 万）。取较大者是让上限偏向不中止；若 Phase 1 有题被上限中止，**必须**把被中止题的实际花费也算进这两个统计量 —— 否则校准会把「花到哪就停了」当成「花完了」，从而把新上限设低。

**这段脚本原先有三处不实现上面那句话（登记 #14）—— 记录在此，因为产物会把自己的规则文字当元数据存下来，而两者看起来完全自洽：**

- **上中位数不是中位数**：脚本 `median = per_task[len(per_task)//2]`，偶数个样本（本例 n=10）取到的是**第 6 小**，不是中间两个的均值。
- **没有取整**：脚本 `max(median, mean) * 10`，规则句要求**向上取整到 10 万**。
- **集合方向相反（三处里最重）**：脚本 `completed = [r for r in ... if r['result']['status'] == 'done']` 把**所有非 `done`** 的题都排除了 —— 这比规则句那半句（「被上限中止的题」）排得**更狠**，因为它连 `deadline_exceeded` 一起丢掉。规则句自己的理由是「否则会把『花到哪就停了』当成『花完了』」，那条理由**不支持**任何排除方向。

**实际落了哪一组**：以规则句为准，但按**理由**而不是按名词取集合 ⇒ 选中 **C = 每一道带 `usage` 的题，无论状态**（`done` / `deadline_exceeded` / `budget_exceeded`）。产物 `derivation.sets` 三组并列（A = 只 `done`、B = `done` + `budget_exceeded`、C = 全部有 `usage` 的），`crosschecks` 逐条给出「换用上中位数 / 换用下取整均值，上限是否变」的布尔读数。**这两条（理由压过名词、以及三组并列）是刻意偏离，不是实现细节** —— 偏离全文在产物自己的 `deviation` 子树里。

- [ ] **Step 2: 写校准记录**

```json
{
  "schemaVersion": 1,
  "basis": "benchmarks/results/phase1-terminal-bench.json",
  "rule": "10 × max(median, mean) per completed task, rounded up to 100k",
  "ceiling": <算出来的整数>,
  "derivation": <上一步脚本的原始输出>,
  "note": "spec §六 的回访触发；用户 2026-09-16 批准把 Phase 2 的上限推迟到第一轮真 usage 之后"
}
```

- [ ] **Step 3: 提交**

```bash
git add benchmarks/results/phase2-calibration.json
git commit -m "docs(bench): Phase 2 token 上限用 Phase 1 的真 usage 校准（T2 Plan B 第 15 件）

不是占位符：spec §六 自己写了「回访触发 = 第一轮真 usage 出来后校准
第二轮的上限」，用户 2026-09-16 也明确选了这条路径。

规则取「中位数与均值中的较大者」是让上限偏向不中止；被中止的题也
算进统计量 —— 只算跑完的会把「花到哪就停了」当成「花完了」。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 16: Phase 2 集成门 —— 一题 SWE-bench 真跑通

**Files:**

- Modify: 视结果而定（driver / adapter）
- Create: `benchmarks/results/phase2-integration-gate.json`

**Interfaces:**

- Consumes: Task 6 的 `tasks.PHASE2_EXPECTED` 与 `--rule first-repos` 重算、Task 9/10 的 adapter（本任务**预期零改动**，任何改动都要在提交信息里说明为什么）、Task 12 的同一张断言表
- Produces: `benchmarks/results/phase2-integration-gate.json`，字段 `{schemaVersion, hostArch, dockerPlatform, manifests, trial, result, declaredArtifacts, driverLogTail}` —— Task 17 与 Task 18 的 SWE-bench 披露取用；`declaredArtifacts` 是本任务新加的、Task 12 没有的那一项（理由见下）

**为什么还要一次集成门：** 两个基准的任务形状相同（`task.toml` + `instruction.md` + `environment/Dockerfile` + `tests/` + `solution/solve.sh`），判分机制也相同 —— 所以适配器**预期零改动**。但「预期零改动」是个断言，得跑出来才算。另外 SWE-bench 的镜像只有 x86 变体（`swebench/sweb.eval.x86_64.*`），在 arm64 Mac 上走模拟，构建时间是 Terminal-Bench 的数倍，这一条也要实测记下来。

**判据不是「容器终态」（2026-09-16 订正，见子仓 `CLAUDE.md` 与 `docs/claude-md-history.md` 同名订正）：** 官方 verifier **跑在独立的 verifier 容器**里，agent 容器跑完即拆，verifier 只读 `task.toml` 声明的 `artifacts`；判据是「声明的 artifacts + 测试脚本退出码 → `/logs/verifier/reward.txt`」，**不是** agent 容器的终态。**这对适配器有一个非平凡推论，本任务必须实测：** agent 在 `/testbed` 里改的东西要能被 verifier 看到，就必须被 `task.toml` 的 `artifacts` 声明覆盖。若该任务声明的 artifacts 不含被改动的路径，**agent 干得再好也传不过去** —— 而症状会是「verifier 判失败」，与「模型没做出来」在结果文件里长得一模一样。因此本任务除下表外，另须读该题的 `task.toml` 把 `artifacts` 逐字抄进 `phase2-integration-gate.json`。

- [ ] **Step 1: 确认镜像与平台**

```bash
uname -m
docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
docker manifest inspect swebench/sweb.eval.x86_64.django_1776_django-15098:latest \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print([(m['platform']['os'], m['platform']['architecture']) for m in d['manifests']])"
```

记录：没有 `arm64` 变体即确认模拟路径，把两条读数写进 `phase2-integration-gate.json`。

- [ ] **Step 2: 先下载 Phase 2 数据集并复算选题**

```bash
cd <repo root>
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  harbor datasets download swebench-verified@1.0 -o benchmarks/.datasets
"$BH" -m benchmarks.tasks --dataset-dir benchmarks/.datasets/swebench-verified \
  --rule first-repos --n 10 --expect-recorded
```

Expected: 10 行，与 `tasks.PHASE2_EXPECTED` 逐字一致（首行 `astropy__astropy-12907`）。**不一致就是选题规则写错了，此时必须停下来改规则并重跑本任务**，不许顺手改录制值。

- [ ] **Step 3: 跑一题**

```bash
export DEEPSEEK_API_KEY=<本机环境>
mkdir -p benchmarks/jobs/phase2-gate
harbor run -p benchmarks/.datasets/swebench-verified -i 'pallets__flask-5014' \
  -a 'benchmarks.harbor.mipham_code:MiphamCode' -m 'deepseek/deepseek-v4-pro' \
  -n 1 -k 1 -o benchmarks/jobs/phase2-gate --job-name phase2-gate \
  --ae "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY" \
  --ae MIPHAM_DAEMON_PERMISSION=bypassPermissions \
  --ae MIPHAM_EXEC_TIMEOUT_SEC=2940 \
  --ae "MIPHAM_BENCH_LEDGER=$PWD/benchmarks/results/ledger.json" \
  -y
```

- [ ] **Step 4: 按 Task 12 Step 2 的同一张表逐条断言**

额外三条：

| 断言                                                   | 期望 | 读不出来意味着                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workdir` == `/testbed`                                | 是   | SWE-bench 的 `[environment]` 里**没有** `workdir`，`/testbed` 只写在 `environment/Dockerfile` 的 `WORKDIR` 里 ⇒ 必须靠容器内实测。若读出的不是 `/testbed`，说明 harbor 的默认目录不是镜像的 `WORKDIR`，此时 adapter 需要显式传 `cwd`                                          |
| 镜像平台含 `amd64` 无 `arm64`                          | 是   | 记录实测，用于披露                                                                                                                                                                                                                                                            |
| **`task.toml` 的 `artifacts` 覆盖了 agent 改动的路径** | 是   | 见本节开头：verifier 在**独立容器**里只读声明的 artifacts。声明不含改动路径 ⇒ agent 的活传不过去，而症状（verifier 判失败）与「模型没做出来」**在结果文件里长得一模一样**。把 `artifacts` 逐字抄进 `phase2-integration-gate.json`；若为空或不覆盖，先解决这一条再往下跑 10 题 |

- [ ] **Step 5: 记录并提交**

```bash
git add benchmarks/results/phase2-integration-gate.json <若改了代码则一并 add>
git commit -m "test(bench): Phase 2 集成门 —— SWE-bench 一题真跑通（T2 Plan B 第 16 件）

两个基准的任务形状相同、判分都是在独立 verifier 容器里读声明的 artifacts，
所以适配器预期零改动 —— 但「预期零改动」是个断言，得跑出来。

SWE-bench 镜像只有 x86 变体，在 arm64 宿主上走模拟，构建时间数量级
不同；这条实测记进结果文件，不写成印象。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 17: Phase 2 正式跑 —— 10 题（10 个不同仓库）

**Files:**

- Create: `benchmarks/results/phase2-swebench-verified.json`

**Interfaces:**

- Consumes: Task 15 的 `phase2-calibration.json` 的 `ceiling`（Step 1 直接读它）、Task 16 的集成门结论、Task 11 的 `run-benchmark.sh --phase 2`
- Produces: `benchmarks/results/phase2-swebench-verified.json`（与 Phase 1 同一 schema）—— Task 18 的 SWE-bench 披露取用；另产出 `benchmarks/results/ledger-phase2.json`（独立台账，**不与 Phase 1 共用**，否则两次作业的用量会互相吃掉对方的额度）

- [ ] **Step 1: 用校准出的上限初始化一本新台账**

```bash
cd <repo root>
CEILING=$(python3 -c "import json;print(json.load(open('benchmarks/results/phase2-calibration.json'))['ceiling'])")
MIPHAM_LEDGER_CEILING="$CEILING" \
MIPHAM_BENCH_LEDGER="$PWD/benchmarks/results/ledger-phase2.json" \
  bash benchmarks/run-benchmark.sh --phase 2 --fresh
```

- [ ] **Step 2: 读结果**

```bash
python3 - <<'PY'
import json
s = json.load(open('benchmarks/results/phase2-swebench-verified.json'))
print(json.dumps(s['totals'], indent=2))
for row in s['trials']:
    print(row['trial'], row['result']['status'], row['result']['usage'])
PY
```

- [ ] **Step 3: 与 Phase 1 并列核对（这三点必须写出来）**

1. 两阶段各自的每题材 token 中位数 —— 若 Phase 2 显著更高，说明校准取小了，**如实写出来并说明它是本轮已知的偏差**，不去回改 Phase 1。
2. `budgetExceededTasks`。
3. 两阶段的通过情况（`done` 只表示回合正常结束，**不代表任务答对** —— 判分由 Harbor 的 verifier 独立完成，读数从作业目录的 verifier 结果里取；取不到就写「verifier 结果未读到」，不许用 `done` 冒充通过）。

- [ ] **Step 4: 提交**

```bash
git add benchmarks/results/
git commit -m "docs(bench): Phase 2 SWE-bench Verified 10 题结果落盘（T2 Plan B 第 17 件）

done 只表示回合正常结束，不代表答对 —— 判分是 Harbor 的独立
verifier 做的。verifier 读不到就写读不到，不用 done 冒充通过。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 18: 披露补充与规格修订申请

**Files:**

- Modify: `benchmarks/README.md`（补 SWE-bench 一节）
- Create: `docs/superpowers/specs/2026-09-17-t2-spec-amendments.md`（**申请**，不是改规格）

**Interfaces:**

- Consumes: Task 14 写下的 `benchmarks/README.md`（本任务在其后追加，**不重写**）、Task 17 的 `phase2-swebench-verified.json`、Task 16 的 `phase2-integration-gate.json`
- Produces: `docs/superpowers/specs/2026-09-17-t2-spec-amendments.md` —— 四条规格分歧的修订**申请**；规格本体在本计划中被视为只读，本任务不触碰 `docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md`

- [ ] **Step 1: 补 `benchmarks/README.md` 的 Phase 2 一节**

补：SWE-bench 的复现命令、x86 模拟的实测读数与它对**墙钟**的影响、两阶段的每题 token 对比、verifier 判分的读数与来源。

- [ ] **Step 2: 写规格修订申请**

规格本身**一字不改**（它是已批准文档）。新建一份申请文件，逐条列出本计划「规格分歧」一节的四条，每条给出：规格原文位置、实测读数、复核命令、建议改法。由用户决定是否落进规格。

- [ ] **Step 3: 提交**

```bash
git add benchmarks/README.md docs/superpowers/specs/2026-09-17-t2-spec-amendments.md
git commit -m "docs(bench): Phase 2 披露 + 规格修订申请（T2 Plan B 第 18 件）

规格是已批准文档，不擅自改；四条分歧写成申请，附实测读数与复核
命令，由用户决定是否落进规格。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 19: 产品页（§五 交付物，父仓子模块）

**Files:**

- Modify: `../websites/domestic/`（**在 `websites/` 子仓库内改**）
- Modify: `../websites/international/`（同上）
- Modify: 父仓 `CLAUDE.md` 的 gitlink 行（按 §十五）

**Interfaces:**

- Consumes: Task 13/17 的两份结果 JSON（只取已落盘的读数，**页面不自己算数**）、Task 14/18 的 `benchmarks/README.md`
- Produces: 子仓 `websites` 的一次 commit（在两站页面内）+ 父仓的一次 gitlink bump；**`benchmarks/` 内不产文件**

**红线：永远不在父仓库中修改子模块文件。** 正确顺序：进 `websites/` 改 → 在 `websites/` 内 commit + push → 回父仓 `git add websites` → 提交 gitlink → 更新父 `CLAUDE.md` 的版本与修订历史。校验：`git ls-files -s websites` 必须等于 `websites` 的 HEAD。

- [ ] **Step 1: 改两个站点的 Mipham Code 页**

只放：两个基准名 + 成绩读数 + 结果文件链接 + 复现命令链接。**不写**「业界第一」「超越某某」这类比较级 —— 本轮是 10 题 × k=1 的自报成绩。
两站的 `src/config/package-info.json` 版本副本若与 `apps/cli/package.json` 不一致，一并同步（这是既有的部署依赖链，见子仓 `CLAUDE.md`「邻居项目」）。

- [ ] **Step 2: 在 `websites/` 内提交并推送**

```bash
cd ../websites
git add domestic international
git commit -m "feat: Mipham Code 公开基准成绩（Terminal-Bench + SWE-bench Verified）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
git push   # 需要用户明确授权
```

- [ ] **Step 3: 回父仓更新 gitlink**

```bash
cd ../../
git ls-files -s websites        # 必须等于 cd websites && git rev-parse HEAD
git add websites
# 更新 CLAUDE.md 的版本号与修订历史行
git commit -m "chore: gitlink 同步 websites —— Mipham Code 基准页"
```

**父仓不跑 prettier**（无配置无依赖，`npx --yes prettier` 会产生 327 行重排）。改完用 `git diff --stat` 对先例形状（`CLAUDE.md | 5 +++--`）。

---

## 计划的产出清单（对照 spec §五）

| §五 交付物                                                   | 本计划的落点                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 适配器 `benchmarks/harbor/mipham_code.py`                    | Task 9、10                                                                   |
| 复现脚本 `benchmarks/`                                       | Task 11（`run-benchmark.sh`）、Task 6（选题 CLI）、Task 7（台账 CLI）        |
| 结果 JSON `benchmarks/`                                      | Task 12、13、15、16、17                                                      |
| 根 `README.md`（复现命令 + 选题规则 + 五条披露）             | Task 14（全文放 `benchmarks/README.md`，根 README 只放结论与链接）           |
| 产品页 `../websites/domestic/`、`../websites/international/` | Task 19（按 §十五）                                                          |
| 规格 §3.5「手写 RFC6455 客户端单列一步」                     | Task 1、2、3（三步，各自独立测试周期）                                       |
| 规格 §3.2 预编译二进制                                       | Task 9                                                                       |
| 规格 §3.3 七步主线                                           | Task 8                                                                       |
| 规格 §3.4 四个实测关键点                                     | Global Constraints（逐条） + Task 9（权限档钉死） + Task 8（WS 早于 prompt） |
| 规格 §3.6 顺带白拿（usage / tool error）                     | Task 4 + Task 10（`toolResults` 进 `context.metadata`）                      |
| 规格 §3.7 凭据                                               | Task 9（`_get_env`）+ Task 10（`--ae` 注入，名字入库、值不入）               |
| 规格 §六 成本上限                                            | Task 7（台账）+ Task 8（中止）+ Task 13（披露）+ Task 15（Phase 2 校准）     |
| 规格 §4.1 五条披露                                           | Task 14                                                                      |
| 规格 §4.2 选题规则                                           | Task 6                                                                       |
| 规格 §七 局限声明                                            | Task 14（「已知限制」一节）                                                  |

**规格里没有被本计划覆盖的：** 无（§一 §二 §七 属于 Plan A / 背景，已在 2.50.0 与 spec 本体中落地）。

---

## 三部分自检

### 1. 规格覆盖

逐节对照见上表。另有一条**刻意不覆盖**：规格 §3.5 的「备选（不推荐）：退回轮询 `GET /messages`」—— 不覆盖即正确，spec 明写不推荐且理由是「没有可靠的回合结束判据」。

### 2. 占位符扫描

本计划里没有任何 `TBD`/`TODO`/「稍后补上」/「加适当错误处理」/「类似 Task N」。两处**看起来**像占位符、实则不是，已就地写明理由：

- **Phase 2 的 token 上限**在 Task 15 才算出来 —— 这是 spec §六 自己写下的回访触发，且用户 2026-09-16 明确批准了这条路径。
- **Task 12 Step 3 / Task 16 Step 4 的「按表定位」**给出了具体症状→具体处置，不是「若失败则调查」。

### 3. 类型与名字一致性

跨任务用到的名字逐个核过：

| 名字                                                                                               | 定义于     | 被用到                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws.WsError` / `ws.encode_frame` / `ws.OP_TEXT` 等                                                 | Task 1     | Task 2、3、8                                                                                                                                                                  |
| `ws.FrameParser.feed`                                                                              | Task 2     | Task 3                                                                                                                                                                        |
| `ws.WsConnection.connect/send_text/recv_text/close` / `_from_socket`                               | Task 3     | Task 8（`connect`/`send_text`/`recv_text`/`close`）、Task 3 测试（`_from_socket`）                                                                                            |
| `protocol.TurnState` / `reduce_message` / `USAGE` / `DONE`                                         | Task 4     | Task 8                                                                                                                                                                        |
| `client.DaemonClient.create_session/prompt/session/wait_until_ready` / `read_port` / `DaemonError` | Task 5     | Task 8                                                                                                                                                                        |
| `main.STEP_ORDER` / `REQUIRED_ENV` / `DriverConfigError` / `driver_env` / `run`                    | Task 8     | Task 8 测试、**Task 9 的 `MiphamCode.driver_env()`（其返回值必须覆盖 `REQUIRED_ENV` 除 `MIPHAM_BUDGET_TOKENS` 外的全部键 —— `DriverEnvContractTest` 钉住）**、Task 12（隐式） |
| `tasks.select_first` / `select_first_repos` / `PHASE1_EXPECTED` / `PHASE2_EXPECTED` / `main`       | Task 6     | Task 11（CLI）、Task 6 测试                                                                                                                                                   |
| `budget.Ledger.remaining/record/reset/entries` / `DEFAULT_CEILING`                                 | Task 7     | Task 10、Task 11                                                                                                                                                              |
| `MiphamCode.name/install_command/install/driver_env/ledger_path/parse_result/apply_context/run`    | Task 9、10 | Task 9 测试、Task 10 测试、Task 11                                                                                                                                            |

**产物链（Task 12–19 之间，靠 JSON 字段而非函数签名相连）：**

| 产物                                    | 产出        | 消费                                                            |
| --------------------------------------- | ----------- | --------------------------------------------------------------- |
| `results/ledger.json`                   | Task 7 / 11 | Task 10（`remaining()`）、Task 13                               |
| `results/integration-gate.json`         | Task 12     | Task 13 Step 3、Task 14「仪器与平台」                           |
| `results/phase1-terminal-bench.json`    | Task 13     | Task 15（校准）、Task 14（披露）、Task 17 Step 3（并列比）      |
| `results/phase2-calibration.json`       | Task 15     | Task 17 Step 1（读 `ceiling`）                                  |
| `results/phase2-integration-gate.json`  | Task 16     | Task 17、Task 18                                                |
| `results/phase2-swebench-verified.json` | Task 17     | Task 18、Task 19                                                |
| `results/ledger-phase2.json`            | Task 17     | 仅 Task 17（**刻意与 Phase 1 分开**，否则两次作业互相吃掉额度） |

四处**已发现并已修正**的不一致：

1. `driver_env` **有两个，不是同一个东西的两处**：Task 8 的 `main.driver_env(source: dict[str, str] | None = None)` 是**读者**（缺 `REQUIRED_ENV` 任一键即抛 `DriverConfigError`），Task 9 的 `MiphamCode.driver_env(self)` 是**写者**、Task 10 的 `run()` 调它。两者之间有一条契约 —— **写者返回的字典必须覆盖 `REQUIRED_ENV` 的全部四键**：`HOME` / `MIPHAM_BUDGET_TOKENS` / `DEEPSEEK_API_KEY` / `MIPHAM_DAEMON_PERMISSION`。初稿此处写的「在 Task 9 定义」是**假的**（上表第 5 行自己写着它定义于 Task 8），「两处签名一致（`() -> dict[str, str]`）」也是**假的**（读者有参数、写者有 `self`）；而这一条真正该记的是那条契约，恰恰被漏掉了 —— 少了 `MIPHAM_DAEMON_PERMISSION` 时，**每一题**都会在容器里起步前抛 `DriverConfigError`，第一次显形是在付费的 Task 12。Task 9 的 Interfaces 与 Steps 已按此订正 —— `driver_env()` 补上该键、`test_adapter.py` 增 `DriverEnvContractTest` 三条断言（缺的键恰为 `run()` 补的 `MIPHAM_BUDGET_TOKENS`），把这次付费失败变成免费失败。
2. Task 8 的 `client_module.read_port` 与 Task 5 导出的 `read_port` 同名 —— 因为 driver 在容器里以脚本方式导入，`client` 这个名字与内置/其他变量无冲突，用 `client_module` 是为了不与 Task 5 测试里的 `client` 包名混淆。
3. `MiphamCode._BINARY_PATH` 与 driver 的 `MIPHAM_BINARY` 默认值都写 `/tmp/mipham/mipham` —— 两处必须相同，且 adapter 每次都用 `driver_env()` 显式传值（默认值只是 driver 单独跑时的兜底）。
4. **（真缺陷，非笔误）** Task 16 初稿写「verifier 在容器终态上重打 `test_patch`」—— 这是**今天上午刚在另两处订正掉的假主张**（子仓 `CLAUDE.md`、`docs/claude-md-history.md`）：官方 verifier 跑在**独立容器**、只读 `task.toml` 声明的 `artifacts`，判据不是容器终态。已在两处就地订正，并据此给 Task 16 补了 `declaredArtifacts` 这一项 —— **订正不只是改措辞**：机制一变，「agent 改的东西能不能到 verifier」就成了必须实测的断言，而它的失败症状与「模型没做出来」在结果文件里完全一样。
5. **（Task 1 评审抓到的真缺陷）** `test_short_text_frame_is_masked_and_round_trips` 的掩码断言**自证**：它把密钥从帧里读出来（`key = frame[2:6]`），再用**同一个**密钥去解自己（`key[i % 4]`）—— 任何密钥都满足它，把 `os.urandom(4)` 换成**任意常量**（含 `b"\x00\x00\x00\x00"`，此时 XOR 即恒等）全套仍绿。RFC 6455 §5.3 的熵要求在 Task 1–3 的套件里**无人执行**。修法加了**两个**测试：`test_masking_key_is_not_a_constant`（同载荷编码两次，密钥必须不同 —— 杀掉**所有只依赖本次调用输入**的密钥变异体：常量、全零、载荷派生、opcode 派生，误报率 2⁻³²；**杀不掉依赖调用历史的密钥** —— 计数器在两次编码上取值不同、却仍是完全确定性的，本机以计数器变异体实测 7/7 仍绿，把它与 `os.urandom` 区分开需要统计检验，超出本任务范围）与 `test_masked_extended_lengths_keep_the_mask_bit`（16/64 位分支此前全用 `mask=False`，`flag | 126` / `flag | 127` 里的 `flag` 从没被带上过 —— 顺带钉住掩码帧的密钥偏移：7 位在 2、16 位在 4、64 位在 10，正是 Task 2 解析器要读回的那个偏移）。测试数 5 → **7**，Task 2 的 12 → **14**。**这一条买到的教训是关于本自检本身的**：上面三节核的是「名字对不对得上」，而这条缺陷**任何一个名字都对**——它要问的是「**这个断言有没有可能失败**」。自检没有覆盖这条轴，所以它漏了，由任务评审补上。**这一条还有第二处缺陷，是我自己写下的**：修复时我把该测试的效力写成「杀掉**全部**确定性密钥变异体」，而我**从未测过「全部」** —— 我测了 4 个自己想到的变异体，再把结论外推成一个全称命题。重审独立构造了一个**计数器**密钥（取值 `b"\x00\x00\x00" + n`），两次编码取值不同 ⇒ `assertNotEqual` 通过，而密钥**零熵**；本机复现 7/7 绿。**处置是订正措辞、不加强测试**：任何有限的确定性检验都分不开「计数器」与「真随机」—— 凡被钉住的序列，一个恰好复现它的确定性生成器都满足；真要做须统计检验，与本任务不相称。**这两条是同一段里两条不同的轴**：前一条问「这个断言**有没有可能失败**」，后一条问「**散文声称的每一个情形它都杀得住吗**」—— 全称量词是一个独立的主张，需要它自己的证据，不能从「我试过的那几个都过了」推出来。

---

## 执行选择

**Plan complete and saved to `docs/superpowers/plans/2026-09-16-t2-harbor-adapter.md`. Two execution options:**

**1. Subagent-Driven（推荐）** —— 每个任务派一个新的 subagent，任务间做两阶段评审（规格符合性 + 代码质量），最后一个整体评审。本计划 19 个任务里 11 个是纯函数 + 单测的机械任务，适合并行节奏；Task 12/13/16/17 是花钱的真跑，必须由主会话掌握。

**2. Inline Execution** —— 在本会话内按 executing-plans 批量执行，带检查点。

**Which approach?**

---

## 执行前需要用户裁决的两件事

1. **规格分歧四条**（本计划「规格分歧」一节）—— 是否落进规格。计划按实测执行、不改规格；Task 18 会写一份修订申请。
2. **Task 19 的 `git push`**（子模块 `websites` 与父仓）—— 按长期规则，每次 push 都需要新的明确授权。

---

## 执行偏差记录

- 2026-09-17 —— 上述 4 行的二进制钉子由 `v0.81.6` 移到 `v0.81.7`（`:66` 那行含两个字面，
  一并改）。原因：`v0.81.6` 的 commit 早于 Plan A（`116b695`），其二进制里 daemon 起不来，
  集成门因此在 1.581 秒内以 `daemon_start_failed` 收场；`v0.81.7` 是第一个含该修复的发布。
  本节的用途只是让后来的读者知道这两处数字为何不一致，**不改动本计划其余任何断言**。
