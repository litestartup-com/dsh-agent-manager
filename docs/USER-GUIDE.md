# Oh! dsh 用户手册

> 对应版本 v1.0.1（蜂群2计划）。面向使用者；路线图见 `MILESTONES.md`，
> 变更记录见仓库根 `CHANGELOG.md`；内部设计笔记在 `notes/`（不随发布物）。

## 0. 一句话

Oh! dsh 在 DeepSeek Harness 之上提供控制面：认证、聊天中继、主脑派工、定时任务、
节点管理、技能清单、记账、备份恢复。默认三件套：

| 角色 | 干什么 |
| --- | --- |
| **manager（总办）** | 控制面：登录、页面、调度、记账、备份 |
| **主脑（总控）** | 跨域规划与派工；对工作区只读，执行永远委托 |
| **个人（工作区）** | 你的工作区 agent：读文件、写文件、git 留痕 |

## 1. 安装（二选一，都是幂等的一键脚本）

### Linux 服务器（容器，推荐）

```bash
mkdir -p /app && cd /app          # 装进你想要的目录：当前目录 = 安装目录
curl -fsSL https://get.ohdsh.com/install.sh -o install.sh
bash install.sh                    # 交互式：API key → 密码 → 域名 → TLS 模式
```

- 直接 `bash install.sh` 交互式逐个问（API key / 初始密码 / 域名留空 = 纯 HTTP / TLS 模式）；
  全自动部署时用环境变量预置：`DEEPSEEK_API_KEY=... APP_DOMAIN=... TLS_MODE=origin-ca bash install.sh`；
- 脚本会**跳过已装好的组件**（Docker / git / unzip），重跑不覆盖任何配置与数据；
- 家目录本身会被拒绝安装（提示先建专用目录）；想看脚本要做什么：`DRY_RUN=1` 预演。

### Windows（本机直跑）

```powershell
irm https://get.ohdsh.com/install.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

- 脚本会**跳过已装好的组件**（Docker / Node / git / pnpm / DSH），重跑不覆盖任何配置与数据；
- 唯一需要输入的是 **DeepSeek API key**（设 `DEEPSEEK_API_KEY=...` 环境变量可全自动）；
- 想看脚本要做什么：`DRY_RUN=1` 预演，`--yes` 跳过确认。

### 域名 + HTTPS（可选进阶，origin-ca 模式）

交互式安装时回答域名、TLS 模式选 origin-ca，然后按提示给证书（三选一）：

1. **提前放置（推荐）**：把证书放进安装目录的 `ssl/cert.pem` 与 `ssl/key.pem`，
   安装时直接回车即可；
2. **安装时输入路径**：提示时粘贴证书/私钥的完整路径；
3. 无人值守：`SSL_CERT_SRC` / `SSL_KEY_SRC` 环境变量指定。

证书来源（Cloudflare）：控制台 SSL/TLS → Origin Server → Create Certificate 下载，
得到 `cert.pem` 与 `key.pem` 两份文件。80 自动 301 到 443，manager 自动开启
secure cookie（`.env` 写入 `NODE_ENV=production`）。letsencrypt 模式：先
`TLS_MODE=letsencrypt` 跑通 80，再在主机执行 `certbot --nginx -d 你的域名`。

### 安装后

浏览器打开 `http://服务器IP`（Windows 本机：`http://127.0.0.1:8080`）→ 登录 →
**首次登录强制修改密码** → 进入首页。初始密码：安装时自设，或看 manager 启动日志
（只打印一次）。

## 2. 界面导览

- **侧栏顶部「主脑」卡片**：总控入口，展开看它的会话；
- **会话列表**：点开即聊；首页直达最近会话；
- **节点页**：所有节点的起 / 停 / 重启 / 日志，加「新增节点」向导；
- **技能页**：每个工作区装了哪些技能（版本 = 工作区 git HEAD）；
- **定时任务页**：cron 自动化；
- **记账页**：花费明细与汇总；
- **铃铛**：站内通知（定时任务成败 / 预算熔断 / 主脑任务完成）。

## 3. 主脑怎么用

在主脑会话里直接说目标，例如：

> 「把 product 工作区的 README 改成中文并提交。」

主脑：规划 → 派工给对应节点 → 回传结果。派工轨迹（delegation 帧）出现在会话里，
点击可跳回被派会话。**主脑只读工作区，执行永远委托**；主脑日预算熔断（默认 $1/天）
只拦自动派工，你手动操作不拦。

## 4. 节点与工作区

- **节点** = 一个 DSH agent 进程（独立 DSH_HOME：会话 / 设置 / 附件互不可见）；
- **工作区** = 该节点操作的目录，文件即真相：每个工作区一个 git 仓，每次运行落一次提交；
- **新增节点**：节点页 →「新增」向导 → 填名字和工作区路径，其余自动（端口 / 密钥 /
  DSH_HOME 自动分配）；删除节点 = 解除托管，磁盘目录保留。

## 5. 技能

工作区里的 `.skills/<名称>/SKILL.md` 就是一个技能（说明 + 工具调用约定），
技能页按工作区列清单。主脑与个人各自读自己的工作区技能。

## 6. 定时任务

定时任务页新建：时间表达式、目标节点、任务描述。连续失败自动停用（不会无底洞烧钱）；
主脑派工受日预算熔断保护。

## 7. 记账

峰谷计价：工作日 09:00–12:00 / 14:00–18:00（Asia/Shanghai）为高峰；
**周六周日全天谷价**。每 run 花费、月度汇总、按工作区分账，全在记账页。

## 8. 备份 / 恢复 / 更新 / 自启

| 操作 | 命令 |
| --- | --- |
| 备份（另有 15 分钟自动快照 + 节点 home 加密归档） | `npm run backup [-- list]` |
| 恢复（自动探测 manager 是否在跑；DB + 节点 home 一起回） | `npm run restore -- latest` |
| DR 演练（临时目录全链路：备份→删除→恢复→断言） | `npm run drill` |
| 自更新（备份→拉新→构建→探活，失败自动回滚） | `npm run update` |
| 开机自启 | `npm run service -- install \| uninstall \| status` |

节点 home（会话/技能/settings）随自动备份一起打包**加密**归档（密钥派生自
SESSION_SECRET，`.env` 丢失 = 备份不可解）；归档保留策略与 DB 快照一致
（24h 全留 → 每日 30 天 → 每周 12 周）。

## 9. 常见问题

- **端口占用**：setup 自检表会红字指出哪个端口被占；换端口用 `--ports 3081,3082`；
- **DSH 版本警告**：本机 DSH 与验证版本不符时警告，`--skip-version-check` 可跳过（风险自负）；
- **主脑不回应**：节点页看主脑是否在线；铃铛看预算是否熔断；
- **忘记登录密码**：`.env` 里改 `MANAGER_INITIAL_PASSWORD` 只对「库里没有用户时」生效；
  真忘了按备份恢复文档处理（见 `notes/` 的运维笔记）。
