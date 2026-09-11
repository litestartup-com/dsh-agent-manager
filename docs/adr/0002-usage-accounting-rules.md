# ADR-0002 · usage 账本两条规则（缺费率不是零 / 月是本地）

- 状态：已接受（2026-09-12 由 `src/usage/store.ts` 模块注释固化）
- 相关代码：`src/usage/store.ts`、`src/pricing.ts`

## 决策

1. **缺费率不是零**：模型没有配置单价的记录计入 `unpriced`，钱数里不含它。
   合计永远被报告为「带可见缺口的底数」，而不是一个碰巧偏低的自信数字。
   `SUM(cost)` 天然跳过 NULL——这正好，但合计本身看不出「有没有缺」，
   `unpriced` 计数器就是为此存在。
2. **月是本地**：分桶由 SQLite 的 `localtime` 修饰符（或等价的本地时区
   epoch 半开区间，债务 B5）产生。UTC+8 的晚间运行落在操作者以为的那个月。
   服务器时区是权威——一个操作者、一台机器。

## 后果

- 日预算熔断依赖这两条规则：把未知成本当零的预算守卫会在「看不见账单」
  的当口继续花钱——所以 `daySpend` 返回 `unpriced`，调用方（cron 调度）
  看到非零缺口即拒绝运行而不是猜。
- 索引红线：分桶过滤必须命中 `usage_at` 索引（`query-plan.test.ts` 的
  EXPLAIN 断言守护），任何聚合改造（E9 drizzle builder 化）不得回退到
  strftime 全表扫写法。
