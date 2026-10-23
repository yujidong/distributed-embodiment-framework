# 部署与运维指南（R15）

> 面向把平台跑在生产/演示环境的运维者：部署方式、数据安全（备份/恢复/升级）、
> 配置自检、可观测性与健康检查。开发环境搭建见根 README。

## 1. 部署形态

单进程架构：一个 Node 进程同时提供 API(:8100)、WebSocket 与构建好的 Web 控制台。
状态三件套：SQLite（WAL 模式）、每仿真 trajectory JSONL、LLM 响应缓存（可选持久化）。

### 生产 VPS 形态（PKU-LZ，153.35.3.18）与公网攻击面

两套部署共用主机与 vLLM（8002 27B / 8004 4B / 8006 v6，均 127.0.0.1）：

| 站点 | 角色 | 公网入口 | 后端 |
|---|---|---|---|
| :8086 | 演示站（eaf-demo） | nginx → 127.0.0.1:8101 | `~/eaf-demo` |
| （无公网） | 实验站（eaf-test） | **仅 SSH 隧道**：`bash scripts/vps-test-tunnel.sh -f` → http://localhost:8087 | `~/eaf-test` :8102 + 127.0.0.1:8087 nginx |

安全姿态（2026-09-15 收口）：实验站不再暴露公网端口——nginx
`listen 127.0.0.1:8087`，node 服务全部 `HOST=127.0.0.1`（两站
`~/eaf-{demo,test}/current.env`），公网只保留演示站 :8086 与 SSH。
两站均已开邀请制（`EAF_INVITE_ONLY=1`，见 §3.2）。访问实验站一律先开
隧道，相关脚本（collect-8087 / r5-* 战役脚本）`EAF_BASE` 默认已是
`http://localhost:8087`。SSH：`ssh eaf-vps`（别名在 ~/.ssh/config）。

### Docker Compose（推荐）

```bash
cp .env.example .env        # 按需修改（JWT_SECRET 必改，见 §3）
docker compose up --build -d
curl http://localhost:8100/api/health   # {"status":"ok",...}
```

- 数据卷 `eaf-data` → 容器 `/data`（SQLite、trajectories、用户场景都在这里）。
- 健康检查打 `/api/health`（公开、轻量、含 SQLite 探活），30s 间隔。
- LLM 后端默认指向 `host.docker.internal:8000/v1`（宿主机 vLLM）；`LLM_MODEL`
  必须与 `--served-model-name` 一致。原 Ollama 默认已移除（R44-B），容器化后端
  的说明见 docker-compose.yml 内注释。
- 建议把 `LLM_CACHE_PATH=/data/llm-cache.db` 加进 `.env`，让 LLM 响应缓存
  跨重启生效（省 token，见 §5）。

### 裸机 / systemd

```bash
npm install && npm run build
cd apps/server && node dist/index.js
```

生产环境必须显式提供：`PORT`、`JWT_SECRET`（32+ 随机字节）、`LLM_BASE_URL`
+ `LLM_MODEL`（缺省则仿真全部 rule-only 降级；原 `OLLAMA_BASE_URL` 已移除
R44-B）、`ADMIN_EMAILS`（否则没有账号能看可观测性面板/做备份）。日志建议 `LOG_FILE=/var/log/eaf/server.log`（自带 10MB×5 轮转）。

## 2. 数据安全（A2，均已实测）

### 备份

数据库运行在 WAL 模式，**不需要停机**：

```bash
# 方式一：管理 API（推荐；ADMIN_EMAILS 账号）
eaf admin backup            # 或 curl -X POST -H "Authorization: Bearer <token>" …/api/admin/backup
# → <DB目录>/backups/eaf-<时间戳>.db，一致性快照，API 继续服务

# 方式二：sqlite3 CLI（服务器所在机器）
sqlite3 /data/eaf.db ".backup '/data/backups/eaf-manual.db'"
```

两种方式等价（都是 SQLite 官方 backup 机制）。备份文件是完整的、可直接使用的
数据库——恢复就是把文件放回去。

### 恢复（round-trip 实测过：migration.vitest.test.ts）

```bash
docker compose stop eaf            # 或停掉 node 进程
cp /data/backups/eaf-2026-08-20T10-00-00.db /data/eaf.db
rm -f /data/eaf.db-wal /data/eaf.db-shm   # WAL 边车属于旧实例，必须一并移除
docker compose start eaf
curl http://localhost:8100/api/health
```

### 升级（migration 链）

启动时自动把旧版本 schema 迁移到最新，逐版本、每步一个事务。v1 → 最新的
全链升级与数据保全由测试固定（`apps/server/src/migration.vitest.test.ts`）；
旧库文件直接用新版本二进制启动即可。

R23 注意事项：v44（`env-claim-delegations`，T-072 zone-claim 裁决委托）
是纯新增表，无数据回填、无停机窗口。治理影响：升级后环境 owner 可把
zone-claim 提案的裁决权委托给一位成员（每环境每 scope 一人）——被委托
裁决通过审计可区分（command_log `decidedVia`），不需要任何部署配置；
不希望使用该能力的部署无需动作（缺省无人被委托，行为与 v43 一致）。

### 备份策略建议

每日定时 `eaf admin backup`（cron/systemd timer）+ 保留 N 份；备份目录在
数据卷内，重要环境建议再异地同步一份（`backups/` 下的文件自包含）。

## 3. 启动配置自检（A4）

`loadConfig` 在启动时**一次性校验全部环境变量**并聚合报错，例如：

```
Invalid configuration (3 issues):
  - Invalid RATE_LIMIT_AUTH_PER_MIN: "abc" is not a positive integer
  - Invalid LOG_LEVEL: "verbose" (expected debug | info | warn | error | silent)
  - Invalid LLM_BASE_URL: "not a url" is not a valid http(s) URL
```

规则：空字符串视为未设置（取默认值）；`LLM_MAX_CONCURRENT`、`LLM_BASE_URL`、
`HASS_URL` 这类过去"用到才炸"的值也在启动时校验。全部变量清单见
`.env.example` 与 `apps/server/src/config.ts` 头注释。

`JWT_SECRET` is **enforced in strict mode**（S3，Task 1）：当 `NODE_ENV=production`
（或显式 `EAF_STRICT_ENV=1`，供裸机/systemd 部署使用）且 `JWT_SECRET` 未设置、
或被设成了内置开发密钥时，服务器**拒绝启动**并给出教学式错误（`openssl rand -hex 32`
生成后设置再重启）——内置开发密钥印在公开源码里，任何读过仓库的人都能伪造
auth token。dev/test 启动保持零配置。非严格模式下每次启动的首批日志都会
**明确声明**当前 JWT 密钥来源（"BUILT-IN DEVELOPMENT default" vs
"operator-provided JWT_SECRET"）——按此一行即可审计某个部署是否还在用公共密钥。

### 3.1 沙箱副本（fork）的配额与保留（S3，Task 2）

- **配额**：`QUOTA_MAX_SANDBOXES_PER_USER_PER_ENV`（默认 3）——每用户在每个环境里
  可持有的 active 副本数。超限时 429 `QUOTA_EXCEEDED`，错误信息直接给出解锁
  路径（`POST /api/sandboxes/:id/stop` 释放槽位）与调参变量。
- **保留（GC）**：`EAF_FORK_MAX_AGE_DAYS`（默认 7；0 = 关闭）。active 副本的
  "最后活动"（行创建时间与该副本 trajectory 目录内最新文件 mtime 的较晚者）
  超过窗口即在**启动时与每小时**被清扫：副本行标记 stopped（配额槽释放）、
  其注册表仿真与 trajectory 目录一并删除（T-011 归属规则：只动平台自建的
  `<EAF_TRAJECTORY_DIR>/<simId>/`，绝不触碰 fork 的源环境——源环境是用户行，
  永不被 GC 修改；普通仿真不在清扫候选集内）。正在运行/暂停的副本视作活动，
  无论多久都不清。启动日志出现 `fork GC: swept N stale sandbox fork(s)` 即本次
  清扫结果。

### 3.2 邀请码运营（alpha 容量管控，schema v57）

alpha 阶段用邀请制控制注册总量：**`EAF_INVITE_ONLY`** 开启时
`POST /api/auth/register` 必须携带 `inviteCode`。默认跟随严格模式——
`NODE_ENV=production` 或 `EAF_STRICT_ENV=1` 时默认**开**，开发/测试默认
**关**；`EAF_INVITE_ONLY=1`/`0` 双向覆盖。`GET /api/health` 的
`auth.inviteOnly` 对外广播当前姿态（web 注册表单据此决定是否必填邀请码）。

- **引导种子（防运维死锁）**：邀请制开启且库中没有任何可用邀请码时，
  启动自动为 `ADMIN_EMAILS` 里第一个邮箱铸一条**一次性**引导码并打到
  启动日志（`bootstrap invite minted for …: EAF-XXXXX-XXXXX`）——用它在
  web 表单或 `eaf auth register --invite-code` 注册出 admin 账号，
  之后一切走管理端点。日志只打这一次；`ADMIN_EMAILS` 为空时会额外告警
  （引导码仍可用，但没人能再铸新码，先配 `ADMIN_EMAILS`）。
- **铸码**：`POST /api/admin/invites {maxUses?, expiresInDays?}`（默认
  1 次、永不过期）→ 201 返回明文码；或 CLI
  `eaf admin invites create [--max-uses N] [--expires-in-days D]`。
  码形如 `EAF-XXXXX-XXXXX`（高熵、无歧义字符），视作凭证交付。
- **查看**：`GET /api/admin/invites` / `eaf admin invites list`——用量
  （usedCount/maxUses）、过期、吊销状态全列。
- **吊销**：`POST /api/admin/invites/:code/revoke` /
  `eaf admin invites revoke <code>`——立即生效，持该码注册得
  410 `INVITE_GONE`。
- **失败语义**：缺码 403 `INVITE_REQUIRED`；码不存在或已用尽合并为
  403 `INVITE_INVALID`（对用户只说"邀请码无效或已用完"，不泄露码的
  任何部分，也不区分"不存在"与"用尽"）；过期/吊销 410 `INVITE_GONE`。
  文案随 Accept-Language 中英双语。失败尝试计入 `/api/auth/*` 限流桶
  （默认 30/分钟/IP），爆破会被 429 节流。
- **用量原子性**：`used_count` 在注册事务内条件自增
  （`WHERE used_count < max_uses`）——并发注册抢最后 1 次余量时只有
  一个成功；用户插入失败会回滚消耗。

以上端点均要求 `ADMIN_EMAILS` 账号（401 未登录 / 403 非 admin）。

## 4. 可观测性（A3）

| 端点 | 鉴权 | 用途 |
|------|------|------|
| `GET /api/health` | 公开 | 容器/k8s 探活：uptime、运行仿真数、SQLite 探活、注册门姿态（`auth.inviteOnly`） |
| `GET /api/metrics` | 登录 | Prometheus 文本：RSS/heap、HTTP 计数、WS 连接/订阅、仿真分布与 tick 成本（max/avg/autoThrottled）、LLM 延迟分位（p50/p95/p99）、LLM 队列深度、token/缓存/triage、DB 大小 |
| `GET /api/admin/observability` | ADMIN_EMAILS | 同源 JSON 摘要 + 逐仿真运行健康（perSim）+ 最近 20 条 5xx |

长时运行盯三个信号：`eaf_process_resident_memory_bytes` 应平台化（soak 基准见
docs/soak-r15.md）；`eaf_sim_tick_wall_ms_avg` 不应随时间上漂；
`eaf_llm_chat_duration_ms{quantile="p95"}` 突增时对照 `eaf_llm_queue_depth`
区分「排队」与「模型慢」（归因方法见 §5）。

## 5. LLM 服务层（C1/C2/C3）

### 后端选择（C2，R44-B 起 vLLM 唯一）

**OpenAI 兼容端点是唯一后端**（原 Ollama 后端已移除 R44-B）：`LLM_PROVIDER=
openai-compatible`（`vllm` 为官方别名）+ `LLM_BASE_URL` + `LLM_MODEL`（必填，
provider 构造需要）+ `LLM_API_KEY`（本地 vLLM 常免密）。vLLM、LM Studio、各云
网关等一切说 `/v1/chat/completions` 协议的服务都走这条路。决策客户端与提案
审查客户端共用同一 provider 选择。

### 以 vLLM 作为推理后端（S-vLLM，R20；R44-B 起唯一后端）

多租户/多世界共享一个推理后端，用 vLLM：capacity-planning §2.1 的历史实测
（已移除的 Ollama 单实例，数字保留）显示它在并发 2–3 处饱和（紧凑 prompt
~3.8 决策/秒、真实 prompt ~2/秒，再高并发只排队不加吞吐）；vLLM 的
continuous batching 没有这个膝盖，吞吐随并发持续爬坡直到 GPU 算力打满。平台
侧零代码改动——`openai-compatible` provider 的请求/响应契约已按 vLLM 文档
逐一核对并用假服务器测试锁死
（`packages/llm-integration/src/vllm-compat.vitest.test.ts`，14 例：标准补全、
reasoning-parser 拆分与原始 `<think>` 两种路径、served-model-name 回显、
404 模型不存在 / 400 超长上下文错误体、length/content_filter finish_reason、
空 choices）。

**安装**：vLLM 面向 Linux/CUDA（pip install vllm；`docs.vllm.ai` 的 quickstart）。
平台只依赖 HTTP 端点，vLLM 跑在任意 Linux 机器/WSL2/容器里均可。

**WSL2 实测三坑**（R85，RTX 5090 + vLLM 0.28 验证）：

1. `RuntimeError: UVA is not available` —— WSL2 默认禁用 pinned memory，启动加
   `VLLM_WSL2_ENABLE_PIN_MEMORY=1`（vllm 源码 `platforms/cuda.py` 的注释即此意）。
2. `FileNotFoundError: 'ninja'` —— JIT 编译子进程按 PATH 找 ninja；venv 装的
   ninja wheel 在 `<venv>/bin`，启动前 `export PATH=<venv>/bin:$PATH`。
3. flashinfer JIT 报 `curand.h` 缺失 / "CUDA compiler and toolkit headers are
   incompatible" —— 系统 `/usr/local/cuda` 与 pip 轮子版本不一致。小模型直接
   绕开：`VLLM_USE_FLASHINFER_SAMPLER=0 VLLM_ATTENTION_BACKEND=TRITON_ATTN`
   （1.5B 决策模型实测足够快）；或把 `CUDA_HOME` 指到 venv 内
   `lib/python3.12/site-packages/nvidia/cu13` 用同一套工具链编译。
4. WSL 里 vllm serve 的端口若与 Windows 侧既有服务冲突（如 8000 被占），换
   `--port 8001`，`LLM_BASE_URL=http://127.0.0.1:8001/v1` 经 localhostForwarding
   可达（`scripts/restart-prod-server.sh` 的自动探测只试 8000，需显式传参覆盖）。

**裸机同款 JIT 坑（2026-09-15，PKU-LZ 事故）**：driver 经 apt 静默升级
（580.173→580.178，未重启）后 vLLM 全部实例崩溃，重启时 flashinfer JIT
重编译失败——根因不是 driver，而是 vllm-env 里 pip 的 nvidia CUDA 组件
版本漂移（训练环境装 cutlass-dsl 时把 nvcc/cccl/nvvm/crt 拉到 13.1–13.3，
runtime 仍是 13.0.96）：nvcc 13.3 + runtime 头文件 13.0 报
"CUDA compiler and CUDA toolkit headers are incompatible"；对齐过程还依序
撞上 ptxas PTX ISA 不匹配（nvvm 13.2→13.0.88）与 `__cudaLaunch` 未声明
（crt 13.3→13.0.88）。修法：把 `nvidia-cuda-nvcc`/`nvidia-cuda-cccl`/
`nvidia-nvvm`/`nvidia-cuda-crt` 全部对齐到 runtime 同族（本次为 13.0.85/88）
——注意 PyPI 上 `-cu13` 后缀包已废弃只剩 0.0.x 占位，要装无后缀新名
（`pip install nvidia-cuda-nvcc==13.0.88`）。手动 nohup 启动的实例须带
`CUDA_HOME=<venv>/lib/python3.10/site-packages/nvidia/cu13` 且 PATH 含
`$CUDA_HOME/bin`（flashinfer 按 CUDA_HOME/PATH 找 nvcc），否则报
"Could not find nvcc"。教训：**训练/推理共用 venv 时，装训练依赖后立即
核对 `pip list | grep nvidia-cuda` 是否仍同族**；driver 升级后的首次
vLLM 重启会强制 JIT 重编译，版本漂移此时才暴露。

**配方**（vLLM 侧 + 平台 `.env`，可整块复制）：

```bash
# ── Linux GPU 机：以稳定别名服务 Qwen3-8B ────────────────────────────
vllm serve Qwen/Qwen3-8B \
  --served-model-name qwen3-8b \
  --reasoning-parser qwen3 \
  --max-model-len 16384
# 可选：平台当前未用 OpenAI function-calling 发工具；若要启用加
#   --enable-auto-tool-choice --tool-call-parser hermes

# ── 本平台 .env（apps/server）────────────────────────────────────────
LLM_PROVIDER=vllm                 # 'openai-compatible' 的官方别名（R20 起接受）
LLM_BASE_URL=http://<vllm-host>:8000/v1
LLM_MODEL=qwen3-8b                # 必须与 --served-model-name 完全一致
# LLM_API_KEY=<token>             # 仅当 vLLM 前面挂了鉴权网关才需要；本地裸服免密
LLM_MAX_CONCURRENT=8              # 见下方并发指引（默认 3 是历史给已移除 Ollama 后端拐点调的）
LLM_TIMEOUT_MS=120000             # 可选：把 provider 超时对齐历史 120s 预算（原 Ollama 默认，已移除）
```

要点：

- **`LLM_MODEL` 必须等于 `--served-model-name`（或未起别名时的完整 HF id）**。
  不一致时 vLLM 返回 404 `{"object":"error","message":"The model \`X\` does not
  exist.","type":"NotFoundError",...}`——平台如实报错、不重试（4xx 归为永久
  错误），决策走 rule-fallback 降级，不会静默。用
  `curl http://<vllm-host>:8000/v1/models` 核对实际接受的名字。
- **`--reasoning-parser qwen3`（推荐开启）**：服务端把 `<think>…</think>` 拆到
  独立的 reasoning 字段，`content` 只剩最终答案。推荐它而不是依赖客户端
  T-103 剥离的理由：T-103 的正则只能剥**闭合**的 think 块，输出被
  max_tokens 截断时的未闭合 `<think>` 会把草稿 JSON 泄进 content；服务端
  解析在截断边角上也正确，且从源头消灭"草稿 JSON 干扰下游解析"这一 R10
  病根。客户端剥离逻辑保留为兜底（对不解析的后端仍生效），两条路径都有
  测试。注意 reasoning-only 输出（content 为 null）会触发平台的诚实报错
  （"no message content"）——这是设计行为，不是 vLLM 故障。
- **上下文长度**：`--max-model-len` 覆盖 prompt+输出。提案审查 prompt 实测
  4.1k tokens（campus 模板），决策 3.4k；超长时 vLLM 返回 400
  BadRequestError（平台同样如实报错不重试）。16k 对当前负载富余。
- **`LLM_TIMEOUT_MS`**：openai-compatible provider 默认 30s（历史：已移除的
  Ollama 后端是 120s）。
  8B 模型 + vLLM 通常秒级返回，默认够用；上 14B/32B 或慢卡时设 120000 对齐。

**并发指引（`LLM_MAX_CONCURRENT`）**：默认值 3 是历史错配——那是对准已移除
的 Ollama 后端拐点调的。vLLM 下起点建议 **8**（capacity-planning §6 大型档的
6–8 上沿），然后用自己的 GPU 实测校准：

```bash
node scripts/capacity-bench.mjs --phase llm --backend openai \
  --base http://<vllm-host>:8000/v1 --model qwen3-8b --runs 12 \
  --out data/devloop/capacity/llm-vllm.json
node scripts/capacity-bench.mjs --phase concurrency --backend openai \
  --base http://<vllm-host>:8000/v1 --model qwen3-8b --levels 1,2,3,5,8,12 \
  --out data/devloop/capacity/concurrency-vllm.json
```

（`--backend openai` 是 R20 加的：harness 以与平台 provider 完全相同的请求
形状打 OpenAI 协议；进程 RSS 采样是 Ollama 专属的会留空，GPU/nvidia-smi 与
吞吐-延迟阶梯照常有效。）读数方法：并发阶梯里吞吐不再增长、p95 开始陡升的
拐点即后端饱和位，把 `LLM_MAX_CONCURRENT` 设在拐点附近；运行期盯
`eaf_llm_queue_depth` 持续 >0 且 `avgWaitMs` 大 ⇒ 还能加，队列恒空但
`eaf_llm_chat_duration_ms` 大 ⇒ 模型/卡瓶颈，加队列无用。

**历史迁移清单（原 Ollama 后端已移除 R44-B；条目 1/3/4/5/6 的差异说明
仍然有效，保留供从旧部署迁移时参考）**：

1. **模型命名**：历史 Ollama 标签（`qwen3-vl:8b`，后端已移除）≠ vLLM 的 HF
   id/别名（`Qwen/Qwen3-8B` 或 `--served-model-name`）。以 `/v1/models` 的返回
   为准。
2. ~~**dev/单用户环境继续用 Ollama**~~：**已失效**——R44-B 起平台只有
   openai-compatible 一条路，本机 :11434 的零配置自动探测与
   `LLM_PROVIDER=ollama`（已移除）一同删除。开发本机要么装 vLLM，要么指向
   远端/团队共享的 OpenAI 兼容端点。
3. **超时预算**：见上，`LLM_TIMEOUT_MS=120000` 对齐。
4. **默认 max_tokens 差异**：openai-compatible 默认 2000（历史 Ollama
   num_predict 4096，后端已移除）。平台决策输出 5–10 tokens、审查 ~123
   tokens，2000 足够；若有调用方依赖"不传 maxTokens 拿 4096"，迁移时显式
   传参。
5. **分流（triage）**：T-113 起分流客户端跟随 `LLM_PROVIDER`，同一
   `LLM_BASE_URL`；历史 `OLLAMA_TRIAGE_MODEL`（已移除）只对旧后端生效，
   vLLM 下用创建仿真时的 `options.triage.model` 指定小模型（否则与主模型
   同名）。
6. **embedding**：openai-compatible provider 不实现 embedding（如实报错）。
   当前服务端没有消费 embedding 的路径，无影响；未来需要时 vLLM 可另起
   embedding 模型实例，但需扩展 provider。
7. ~~**回退 Ollama**~~：**已失效**——后端已移除，无路可退；平台语义（降级、
   重试、队列、缓存）与后端无关这一结论不变。

### 并发治理（C1）

所有 LLM 调用共享一个全局队列，上限 `LLM_MAX_CONCURRENT`（默认 3，启动时
校验并应用到运行中的队列）。队列在管理摘要/Prometheus 中可见：
`eaf_llm_queue_depth`（当前等待）、`eaf_llm_queue_active`、以及等待统计
（`waitCount`/`avgWaitMs`/`maxWaitMs`/`depthHighWater`）。30 人课堂按后端
吞吐上调（如 6–8），观察 `depthHighWater` 是否回落。

**fast-lane 与自适应并发（R44-F1 + plan-r84 Wave D）**：模型名带
`ac-decision` 前缀的小模型决策调用走独立的 fast-lane 队列，不与全局道的
大模型调用互相头阻。槽位默认**自适应**：在 `LLM_FAST_LANE_MIN` /
`LLM_FAST_LANE_MAX`（默认 8/32）之间伸缩——从 min 起步，队列持续非空
（>250ms）且窗口内无 429、失败率 ≤25% 时每次 +4 升档；出现 429 立即减半、
窗口失败率 >25% 也减半（不低于 min）；两次调整间隔 ≥1s 防振荡。R44 实测
依据：std 档 32 槽空转、dense 档 16 槽才首次触到引擎排队边界，固定值不是
自限就是过冲。容量实验需要钉死槽位时显式设 `LLM_FAST_LANE_CONCURRENT`
（如 16），此时自适应关闭、行为与 Wave D 之前完全一致。运行期观测：
`/api/health` 与管理摘要的 `llmFastLaneQueue`（maxConcurrent 为当前档位，
`adaptive.min/max` 为边界）。

每类调用有独立超时预算：决策（引擎内 AC 评估）、提案审查
（`PROPOSAL_REVIEW_LLM_TIMEOUT_MS`，默认 60s）、AC 评估。超时走降级路径
（rule 决策 / 超时自动通过策略），不会瘫痪通道。

### 决策失败的有界降级（T-022，DevLoop R17）

LLM 后端配置了但宕机/慢坏时，决策路径不再静默丢弃每个需要 LLM 的事件
（R10 ED-F01：无决策记录、无 API 可见错误，仿真看起来健康）。策略分两段：

1. **有界重试**：仅对瞬时错误（连接拒绝/重置、超时、DNS、429/5xx 网关）
   重试 `LLM_DECISION_RETRIES` 次（默认 1），线性退避
   `LLM_DECISION_RETRY_BACKOFF_MS`（默认 500ms）。永久性错误（401/404、
   未知模型）不重试。重试内联在决策路径上，总阻塞 ≤
   (1+重试次数)×provider 超时 + 退避，绝不超出既有超时预算。
2. **诚实降级**：重试耗尽后按 `LLM_DECISION_FAILURE_POLICY` 处置：
   - `rule-fallback`（默认）：决策**照常落盘**——decisionSource 为
     `rule-llm-down`，reasoning 记录 provider 错误原文与尝试次数，决策值
     取确定性能力规则（能力齐全 → 独立处理，有缺口 → 挂起）。snapshot 的
     `llm.llmErrors`（T-105）与 trajectory 的 `llm-failure` 记录同步可见。
   - `drop`：恢复旧语义——该事件不产生决策记录，仅 T-105 计数器与
     trajectory 失败记录可观测（评估对照场景可用）。

错误瞬时性判定见 `@active-collaboration/llm-integration` 的
`isTransientLLMError`（网络/超时/5xx 特征 → 瞬时；4xx 鉴权/NotFound →
永久；无法归类默认按瞬时处理，避免把死端口误判为永久而重回静默丢弃）。

### 延迟归因（C3）

当决策变慢（soak 实测锚点：qwen3-vl:8b 单次生成 p95≈33s），按此分诊：

1. **看排队**：管理摘要 `llm.queue`——`queued` 持续 >0 且 `avgWaitMs` 大
   ⇒ 并发上限不足，调高 `LLM_MAX_CONCURRENT`（前提是后端扛得住）。
2. **看端到端 vs 等待差**：`llm.latency.p95`（含排队）减去 `avgWaitMs`
   ⇒ 模型本身耗时。模型慢时：启用 triage 小模型（`OLLAMA_TRIAGE_MODEL`，
   enforce 模式可跳过大模型）、换更小模型、或提高后端并发能力。
3. **看错误率**：`llm.latency.errors` 增长 ⇒ 后端不可达/超时，检查
   `LLM_BASE_URL`/`OLLAMA_BASE_URL` 与超时预算的匹配。
4. **回放取证**：trajectory JSONL 记录每次调用的 durationMs/prompt/response
   （`<EAF_TRAJECTORY_DIR>/<simId>/`），可对单个慢决策逐条复盘。

实测参考（R15 soak，见 docs/soak-r15.md；历史数据——当时后端为已移除的
Ollama qwen3-vl:8b）：p95 33.2s、队列深度恒 0 —— 延迟全部来自模型生成，
属第 2 类。

### 提案治理安全阈值（DevLoop S1）

跨租户提示注入防御与"高危提案必须人工审查"的阈值，均由确定性规则层执行
（`apps/server/src/proposal-rules.ts` / `proposal-human-review-policy.ts`）：

- **提示注入门（始终开启，不可配置）**：提案载荷（值与键）命中规范检测器
  （`packages/core/src/security/prompt-sanitizer.ts` 的同一模式表，事件叙事、
  设备名、任务描述均可携带）→ 直接升级给环境 owner，`riskLevel=high`，绝不
  自动应用，AI 审查根本不会被调用（审查模型本身即攻击目标）。
- **人工审查广度阈值（部署级环境变量，默认 0 = 未启用）**：
  - `PROPOSAL_HUMAN_REVIEW_MAX_AGENTS` — 一条 install-agents 提案安装超过 N
    个 agent（"代理舰队"式委托广度；Flow 不走提案通道，见 routes/flows.ts，
    故以 agent 舰队为委托广度类）→ 升级；
  - `PROPOSAL_HUMAN_REVIEW_MAX_EVENTS` — 一条 inject-scenario 提案烘焙超过
    N 个定时事件 → 升级；
  - `PROPOSAL_HUMAN_REVIEW_MAX_ZONES_TOUCHED` — 一条提案触及超过 N 个不同
    zone（跨区访问广度）→ 升级。
- **按环境收紧（owner 手笔）**：环境 owner 通过 `PATCH /api/environments/:id`
  的 `mapData.governance.humanReview.{maxAgentsPerProposal,maxEventsPerProposal,maxZonesTouched}`
  可逐字段覆盖部署默认（与 zone `consentClass` 同一 authoring 通道；提案本身
  永远无法改写它）。生效值只读地出现在环境详情 `governance.humanReview`。
- **保守允许清单**（什么仍会自动应用）：规则检查通过 + 低风险 + 无 hass://
  绑定/超大批次/监护区/zone claim/跨方协议级联 + 无注入特征 + 未触任何已启用
  广度阈值 —— 缺一即人工审查。默认（三个阈值全 0）行为与 S1 之前完全一致，
  仅新增注入门。

## 6. 停机语义与世界会话恢复（S3，Task 3/4）

### 墙钟契约（wall-clock contract）

权威世界会话（world session）以 `simStartEpochMs`（T-410，暴露在 env 详情的
`worldSession.simStartEpochMs`）为墙锚，基率 `simPerWallSec`（默认 1：
1 sim-sec / 墙-sec）。世界的"现在"恒等于：

```
worldNowSimSec = (wallNowMs − simStartEpochMs) / 1000 × simPerWallSec
```

因此**服务器停机多久，世界就"迟到"多久**——这是设计语义，不是漂移。重启后
第一次到达（数据读、无显式 simulationId 的流、装 fresh 义务的协议激活、改
世界的提案 apply）会：

1. 从磁盘 checkpoint 恢复世界动力学，重建进**当前 env 行**的拓扑（停机期间
   env 行变了 → `driftWarning` 教学告警，T-037 语义）；
2. 以墙锚换算出 wall-now，分块 `advanceTo` 快进穿过空窗——窗口内每个到期
   时刻（计划事件、flow 调度、occupancy 边界、Fix-12 复核）**恰好执行一次、
   按序执行**；checkpoint 携带的已触发标记使"重复触发"在结构上不可能。该
   语义由测试钉死（`apps/server/src/world-session-resume-s3.vitest.test.ts`：
   重启 + 10 墙-sec 停机窗口 → 漏掉的 dues 各恰好一次，已触发的不重放）；
3. 墙锚跨休眠/重启**永不跳变**（恢复路径原样采纳 checkpoint 的锚）。

**不重放的东西**（诚实边界）：停机期间用户本可发出的命令不会被补发
（`externalDueSimSec` 重放尾缝隙已留、当前 API 面为空集，排队动作属后续
议题）；env 行层面的治理变更经"重建即重放"落地。普通（非会话）仿真是内存
注册表——运行中的 sim 不跨重启存活，trajectory 留在磁盘按 T-011 保留期
自然过期；每用户的 hibernated sim 记录同样不跨进程（其 checkpoint 文件按
保留期清扫）。世界会话的跨进程恢复见下。

### 跨进程恢复（S3，Task 3）

休眠世界会话此前只活在注册表内存——重启即丢（checkpoint 留在磁盘）。现在：

- **启动扫描**：boot 时扫 `<EAF_TRAJECTORY_DIR>/sim-<envId>-world-session/
  checkpoint.json`（确定性会话 id 使其按 env 可识别），登记为轻量休眠记录
  ——env 详情立即显示 `worldSession: hibernated` 及 checkpoint 元数据
  （checkpointAtSec / hibernatedAt / simStartEpochMs），无需任何到达。
- **惰性重绑**：无内存会话的 env 在首次到达时先查磁盘 checkpoint——找到
  则续接历史（快进到 wall-now），而不是从 t=0 重建世界。
- **保留上限**：停机超过 `EAF_TRAJECTORY_MAX_AGE_DAYS`（默认 7 天）时，
  checkpoint 先被 T-011 启动清扫回收——世界下次从零开始（超出保留期的
  历史本就不承诺存在；重要世界请先备份）。checkpoint 损坏：boot 日志
  per-file 警告，该 env 降级为全新世界，绝不阻塞启动。

### 运维手册片段：崩溃/重启后会发生什么

```text
# 重启后看启动日志：
#   world session recovery: rebound N hibernated world session(s) from checkpoints
#     → N 个环境的世界已挂起待唤醒（env 详情 worldSession.status=hibernated）
#   world session recovery: checkpoint ... not adoptable (...)
#     → 该 checkpoint 损坏/版本不符，env 将在下次到达时从零建世界
#   （没有 rebound 日志 + env 本有会话 → 停机超保留期，或进程从未休眠过会话）

# 每个环境第一次到达时：
#   - 会话唤醒并快进：simTimeSec 一跃超过 checkpointAtSec；
#   - 停机窗口内到期的计划事件/flow 调度按序补发（各恰好一次）——
#     预期一次活动突发，属正常；
#   - 停机期间 env 行有变 → worldSession.driftWarning 列出增删的拓扑；
#   - simStartEpochMs 与停机前一致（时间基不跳变，可用它核算迟到量）。

# 用户侧：
#   - 运行中的普通仿真（含沙箱副本）不跨重启：用户需重建；
#     其 trajectory 按 EAF_TRAJECTORY_MAX_AGE_DAYS 保留供回放/取证。
#   - 数据库、场景、协议、flow 定义都在 SQLite 里，原样存活。
```

## 6.5 限流与批量场景退避（R78-G）

认证通道（登录/注册）与写操作带每 IP 限流（生产默认开启，`RATE_LIMIT_ENABLED=false`
可关）。三类桶：`RATE_LIMIT_AUTH_PER_MIN`（登录/注册等暴力破解面，默认 30）、
`RATE_LIMIT_SESSION_PER_MIN`（`/auth/me` 会话读态，默认 300——Wave A / A1 拆出，
页面整载 bootstrap 不再与暴力破解面共享配额）、`RATE_LIMIT_WRITE_PER_MIN` /
`RATE_LIMIT_GLOBAL_PER_MIN`（默认 30 / 300）。
超限返回 **429**，错误体的 `error.retryAfterSec` 是机器可读的等待秒数——
批量场景（课堂 30 人注册、自动化 persona 旅程）应消费它而不是盲等：

- 收到 429 → 等待 `retryAfterSec + 2` 秒后重试，最多 4 轮；
- 并发注册建议 ≤2 路（R77 十 persona 并发 2 + 上述退避全程零失败；早期
  并发 4 的批次曾整批撞限）；
- 探针/自动化线束参考 `data/campus-e2e/ui/persona-r77.mjs` 的 `apiLogin`。

## 7. 常见故障

| 症状 | 处置 |
|------|------|
| 启动即退，报 Invalid configuration | 修 `.env` 对应项（一次报全部） |
| 文档端点 404 ROUTE_NOT_FOUND | dist 落后于 src——`npm run build` 后重启（启动自检也会告警） |
| 端口被占/行为诡异（Fix-46） | 启动日志搜 "PORT HIJACKED"；`docker ps`/`netstat -ano` 找同端口进程 |
| 仿真全部 rule-only | `OLLAMA_BASE_URL` 未配置或不可达；创建响应的 `llmWarning` 会说明 |
| 决策记录大量 `rule-llm-down` | LLM 后端宕机/超时，决策已按规则降级（T-022）；看 `llm.llmErrors` 与 trajectory `llm-failure` 记录定位 provider 错误 |
| 备份 403 | 操作账号不在 `ADMIN_EMAILS` |
