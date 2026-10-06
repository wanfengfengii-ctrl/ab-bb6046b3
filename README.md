# Trace Causality Audit

卫星测控平台的跨服务调用链审计服务。给定一组**无序** span 和每个服务时钟相对真实时间的
偏差上限，判断是否存在「每个服务一个整数时钟偏移」的校正方案，使整条追踪的所有父子
调用在时间上自洽（每个子跨度完整落在父跨度内）。

- 运行时零依赖：Node.js 22 + 内置 `node:http`
- 整数运算全程使用 BigInt，无浮点误差
- Docker 多阶段构建：`production`（API）与 `verify`（一次性核对任务）

## API

### `POST /api/traces/audit`

请求：

```json
{
  "maxClockSkewUs": 100,
  "spans": [
    { "spanId": "q", "service": "s2", "parentSpanId": "p", "startUs": 1050, "endUs": 2050 },
    { "spanId": "p", "service": "s1", "parentSpanId": null, "startUs": 1000, "endUs": 2000 }
  ]
}
```

- `maxClockSkewUs`：非负整数，允许的每服务时钟偏移绝对值上限（微秒）
- `spans`：1–500 项，顺序无关；`parentSpanId` 为 `null` 或省略表示根

合法追踪返回 `200`：

```json
{ "spanCount": 2, "serviceCount": 2, "valid": true }
```

当追踪结构合法、但不存在同时满足全部父子关系的偏移组合时：

```json
{ "spanCount": 2, "serviceCount": 2, "valid": false, "reason": "temporal_inconsistent" }
```

结构错误返回 `422` 与稳定错误码：

```json
{ "error": { "code": "multiple_root_spans", "message": "..." } }
```

| code | 触发条件 |
| --- | --- |
| `invalid_request` | body 不是 JSON 对象 / JSON 解析失败 / body 过大 |
| `invalid_max_clock_skew` | `maxClockSkewUs` 不是非负整数 |
| `invalid_spans` | `spans` 不是 1–500 项的数组 |
| `invalid_span` / `invalid_span_id` / `invalid_service` / `invalid_parent_span_id` / `invalid_timestamp` | 字段类型或空值不合法 |
| `invalid_span_interval` | `startUs >= endUs` |
| `duplicate_span_id` | spanId 重复 |
| `parent_span_not_found` | parentSpanId 指向不存在的 span |
| `no_root_span` / `multiple_root_spans` | 根数量不等于 1 |
| `span_graph_cycle` | 存在环或有不可达的孤立子树 |

### `GET /health`

返回 `200 {"status":"ok"}`，供容器健康检查与 `verify` 任务依赖使用。

## 判定模型

设服务 `s` 的时钟偏移为整数 `o(s)`（校正时间 = 记录时间 + `o(s)`），
`|o(s)| <= maxClockSkewUs`。对子跨度 c、父跨度 p 要求：

```
start_c + o(c) >= start_p + o(p)   ⇒   o(p) - o(c) <= start_c - start_p
end_c   + o(c) <= end_p   + o(p)   ⇒   o(c) - o(p) <= end_p   - end_c
```

这些都是形如 `x_v - x_u <= w` 的**差分约束**，连同
`-K <= o(s) <= K`（用虚拟节点 z 的两条权 K 边表示）构成约束图。
差分约束系统可满足，当且仅当约束图不含负权环——由 Bellman-Ford 检测。
因此：

- 不会把「各服务时钟有界偏差但可校正」的情况误报为链路倒置；
- 同一服务内无法靠单一偏移消除的真实倒置，仍会被判定为不可校正；
- 每个服务的所有 span 共用同一个偏移，跨多次调用的矛盾约束会形成负环。

## 本地开发

```bash
npm ci
npm test       # 类型检查 + 单元/HTTP 测试（node --test）
npm run build  # tsc 产物到 dist/
npm start      # 启动 API（默认 :8080，可用 PORT 覆盖）
npm run smoke  # 对本地构建产物做 HTTP 冒烟
```

## Docker Compose

```bash
docker compose build
docker compose up                # 启动 API
API_PORT=9090 docker compose up  # 宿主机端口可用环境变量配置
docker compose run --rm verify   # 或随 up 自动运行：见下
```

- `api`：生产镜像，含 `HEALTHCHECK`，宿主机端口由 `API_PORT`（默认 8080）配置
- `verify`：一次性任务，`depends_on: api: service_healthy`；API 健康后依次执行
  单元/HTTP 测试、生产构建、对运行中的 API 做可校正/不可校正/结构错误三类
  HTTP 冒烟，全部通过则退出码 0，否则非零。`docker compose up` 时它核对完
  成后会自行退出（`restart: "no"`）。

查看 verify 结论：

```bash
docker compose up verify
docker inspect --format '{{.State.ExitCode}}' $(docker compose ps -q verify)
```
