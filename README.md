# 卫星测控分布式追踪因果审计服务 (Trace Causal Audit)

多个测控服务以各自的本地时钟记录调用跨度（span）。本服务在**不假定时钟已同步**的
前提下，判断整条追踪（trace）是否**可能**满足调用因果：为每个服务寻找一个统一的
整数时钟偏移（允许范围内），使校正后的每个子跨度完整落在其父跨度区间内。可由时钟
偏差解释的“看起来倒置”不会被误报；只有不存在任何可行偏移组合时才判定为
`temporal_inconsistent`。

## API

### `POST /api/traces/audit`

请求体：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `maxClockSkewUs` | 非负整数 | 每个服务允许的时钟偏移上限 `S`，偏移可取 `[-S, +S]` 内任意整数（单位 µs） |
| `spans` | 数组，1–500 项 | 无序跨度列表 |

每个 span：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `spanId` | 非空字符串 | 全追踪唯一 |
| `service` | 非空字符串 | 所属服务；同一服务的全部 span 共用一个偏移 |
| `parentSpanId` | `null` 或非空字符串 | 父跨度；根为 `null` |
| `startUs` / `endUs` | 整数 | 起止时间；必须 `startUs < endUs`（可为负） |

成功响应 `200`：

```json
{ "valid": true, "spanCount": 2, "serviceCount": 2 }
```

不存在满足全部父子包含关系的偏移组合时（结构合法但时序不可校正）：

```json
{ "valid": false, "reason": "temporal_inconsistent", "spanCount": 2, "serviceCount": 2 }
```

结构错误返回 `422`，并带**稳定错误码** `error`：

| 错误码 | 触发条件 |
| --- | --- |
| `invalid_body` | 非 JSON 对象 / 畸形 JSON / 非 JSON 内容类型 |
| `invalid_max_clock_skew` | `maxClockSkewUs` 缺失或不是非负整数 |
| `invalid_spans` | `spans` 不是数组，或数量不在 1–500 |
| `invalid_span` | span 字段缺失/类型错误，或 `startUs >= endUs` |
| `duplicate_span_id` | `spanId` 重复 |
| `unknown_parent` | `parentSpanId` 指向不存在的跨度 |
| `multiple_roots` | 多于一个根（多个 `parentSpanId: null`） |
| `no_root` | 没有根（如纯环） |
| `cycle_detected` | 存在根不可达的游离环（未构成一棵完整树） |

另有 `GET /health`，健康时返回 `200 {"status":"ok"}`。

## 判定原理

设服务 `s` 的未知整数偏移为 `o_s ∈ [-S, S]`，校正后区间为
`[start + o_s, end + o_s]`。对每条父子边 `p → c`，要求：

```
start_p + o_p ≤ start_c + o_c        （子不早于父开始）
  end_c + o_c ≤   end_p + o_p        （子不晚于父结束）
```

整理成差分约束 `o_v − o_u ≤ w`：

```
o_p − o_c ≤ start_c − start_p
o_c − o_p ≤   end_p − end_c
```

再为偏移上下界引入固定为 0 的虚拟节点：`o_s ≤ S` 与 `−o_s ≤ S`。
全部约束构成差分约束图，**存在可行偏移组合 ⇔ 图中无负环**，用 Bellman–Ford 判定。
约束矩阵全幺模且权重均为整数，因此只要实松弛可行就必有整数可行解，天然满足
“偏移必须是整数”的要求。

关键点：每个服务**一个**偏移（同一服务的所有 span 必须同时被修正），因此同服务内
的倒置任何偏差都无法校正；而跨服务的“倒置”可由两端各分担最多 `S`（相对修正量
最大 `2S`）来校正。

## 本地开发

```bash
npm install --cache .npm-cache   # 如遇 ~/.npm 权限问题可指定本地缓存
npm test                         # vitest，35 个用例
npm run build                    # tsc 产物到 dist/
npm start                        # 启动 API（默认 0.0.0.0:3000）
BASE_URL=http://127.0.0.1:3000 node scripts/smoke.mjs
```

## Docker 交付

```bash
docker compose up -d --build api         # 启动 API
docker compose run --rm verify           # 一次性校验：测试 + 生产构建 + HTTP 冒烟
API_PORT=8080 docker compose up -d api   # 自定义宿主机端口
```

- `api`（多阶段构建的 `runtime` 目标）提供 `/health` 健康检查（Dockerfile 与
  Compose 均有定义），容器内监听端口由环境变量 `PORT`（默认 3000）、`HOST`
  （默认 `0.0.0.0`）配置，**宿主机端口由 `API_PORT` 配置**（默认 3000）。
- `verify`（`verify` 目标）是**一次性**服务：`depends_on: api: condition:
  service_healthy` 保证 API 健康后才启动；依次运行代码测试、生产构建、可校正与
  不可校正（含 422 结构错误）追踪的 HTTP 冒烟，以退出码汇总结论，随后自行退出
  （`restart: "no"`）。

## 项目结构

```
src/
  errors.ts       稳定错误码与校验异常
  clockSolver.ts  差分约束 + Bellman–Ford 负环判定
  audit.ts        请求校验、树结构检查、服务编号与求解编排
  server.ts       Fastify 路由 / 422 映射 / 错误处理
  index.ts        入口（PORT/HOST 环境变量）
test/             vitest：求解器、审计、HTTP 三层用例
scripts/smoke.mjs HTTP 冒烟（健康检查 + 可校正/不可校正/422）
scripts/verify.sh verify 服务入口（test → build → smoke）
```
