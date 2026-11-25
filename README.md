# Prompt Manager (Pages)

GitHub 存储 + GitHub Pages 静态部署 + GitHub 登录提 PR 审核的静态版引擎。

## 目录结构

```text
├── packages/shared/       # Schema、变量解析、规则检查与旧版只读 API 格式化
├── scripts/               # 内容校验、静态索引构建、PR 预览与斜杠指令脚本
├── web/                   # React + TypeScript + Vite + Tailwind CSS 前端
├── worker/                # Cloudflare Worker (OAuth、提交 PR、只读 API、管理接口)
└── .github/workflows/     # CI 与可复用部署/PR 工作流
```

## 本地命令

```bash
pnpm install
pnpm test
pnpm typecheck

# 指定数据目录启动预览或构建
CONTENT_DIR=/path/to/data-repo/content \
SITE_CONFIG_PATH=/path/to/data-repo/site.config.json \
pnpm build
```

## 部署

1. 新建数据仓库，放入 `site.config.json`、`content/` 与 `.github/workflows/{deploy,pr-preview,pr-command}.yml`（调用本分支的可复用工作流）。
2. 在数据仓库 **Settings → Pages** 将 Source 设为 **GitHub Actions**。
3. 按 [worker/README.md](worker/README.md) 部署 Cloudflare Worker，将地址填入数据仓库 `site.config.json` 的 `workerApiUrl`。
4. *(可选)* 在数据仓库 Actions Secrets 中配置 `AI_API_KEY`（及 `AI_BASE_URL`、`AI_MODEL`），启用 PR 评论中的 AI 标签与提示词建议。
