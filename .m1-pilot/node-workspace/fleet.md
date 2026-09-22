# fleet 拓扑与边界（manager 生成，勿手改）

本文件由 manager 从配置自动生成——网络拓扑、节点清单与边界以这里为准。
改拓扑 = 改 `manager.config.yaml` 或用向导加/删节点；本文件随之一同更新。

## 关键地址（用环境变量，绝不写死值）

- manager 内部 API 基址：`$MANAGER_URL`（bash）/ `$env:MANAGER_URL`（pwsh）
- 内部 API 鉴权头：`X-Brain-Token`，值在环境变量 `BRAIN_TOKEN`（只引用、绝不打印/写文件）
- 浏览器入口：用户给的 URL（nginx 80/443）；节点端口只在容器/本机内网，不对外

## 节点清单

- **personal**（个人）：进程 · 托管 · 私有
- **brain**（主脑）：进程 · 托管 · 私有
- **product**（product）：进程 · 托管 · 私有
- **pilot01**（pilot01）：进程 · 托管 · 私有

## 边界（红线，所有节点一致）

1. 每个节点只读写**自己的工作区**（本目录）；跨节点的一切执行都通过 manager 派工。
2. 主脑对 fleet 只读：观察用内部 API，执行永远派工给 worker。
3. 环境变量（`BRAIN_TOKEN` / `MANAGER_URL` / `GW_KEY_*`）只引用不打印、不落盘。
