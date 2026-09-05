# 发布清单（维护者）

> v1.0.1 起每次发布照此走一遍；任何一步失败 = 不发布。原则：恢复过才算备份过，验收过才算发布过。

## 0. 前置（一次性）

- GitHub Actions CI 全绿（test + drill + typecheck + audit + build + check-docs）；
- 镜像推送凭据：Docker Hub（+ 国内 registry 如阿里云 ACR）登录。

## 1. 版本

1. `package.json` version → `1.0.1`；
2. `CHANGELOG.md` 顶部新增版本节（功能/修复，抄自 commit 历史）；
3. `README.md` / `docs/USER-GUIDE.md` 走查：死链断言（`node scripts/check-docs.mjs`）、
   两条一键命令、CLI 表与 `package.json` scripts 一致。

## 2. 镜像

1. 构建并推送（版本与 DSH 版本钉死）：
   ```bash
   docker build -t ohdsh/dsh-node:0.1.1-rc.2 -f images/node/Dockerfile images/node
   docker build -t ohdsh/manager:1.0.1 -f images/manager/Dockerfile .
   docker push ohdsh/dsh-node:0.1.1-rc.2 && docker push ohdsh/manager:1.0.1
   ```
2. 国内 registry 同步（若配置）。

## 3. 发布包

```bash
OHDSH_VERSION=v1.0.1 node scripts/make-release.mjs
```

## 4. GitHub Release

1. `git tag v1.0.1 && git push origin v1.0.1`（tag 必须落在 HEAD）；
2. Release 页：标题 `v1.0.1 · 蜂群2计划（产品级单机版）`；
3. 上传 `dist-release/ohdsh-compose.zip`、`install.sh`、`install.ps1`；
4. 发布说明 = CHANGELOG 对应节。

## 5. 验收（9 条对照 REVIEW 文档 §4，全部打勾才发布）

1. 全新 Windows 机器 install.ps1 5 分钟进首页；全新 Ubuntu install.sh 5 分钟进首页；
2. README 零死链（CI 断言）；
3. setup 自检表无半成功态；
4. 版本治理（COMPAT/校验/告警）生效；
5. 首登强制改密 + CSRF + 审计可见；
6. `npm run drill` 全链路通过（CI 常驻）；
7. 服务化实证：systemd/schtasks 下节点可写工作区；
8. E2E：`npm run smoke` 全绿 + fresh-clone 冒烟；
9. 发布物齐整（本节 1–4 全过）。

## 6. 发布后

- `get.ohdsh.com/install.sh` / `install.ps1` 指向本版 Release 资产（CDN/托管同步）；
- 通知用户群（changelog 链接）。
