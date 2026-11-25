# Cloudflare Worker 部署说明

提供 GitHub OAuth 登录、提交 PR、兼容只读 API（`/api/gallery`、`/api/templates`）及管理员直推接口。

## 1. 创建 GitHub OAuth App

GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**：
- **Homepage URL**：`https://<username>.github.io/<data-repo>/`
- **Authorization callback URL**：`https://<worker-domain>/auth/callback`

记录 `Client ID` 与 `Client Secret`。

## 2. 创建目标仓库写入凭据（二选一）

- **Fine-grained PAT**：仅勾选目标数据仓库，授予 `Contents: Read and write` 、`Pull requests: Read and write` 与 `Actions: Read`。
- **GitHub App**：同上权限并安装到目标数据仓库，记录 `App ID`、`Installation ID` 与私钥（支持 GitHub 默认下载的 PKCS#1 和 PKCS#8 格式；也可手动转换：`openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app-pkcs8.pem`）。

## 3. 配置与部署

```bash
cd worker
# 按需修改 wrangler.toml 中的仓库名、域名和 ADMIN_LOGINS

pnpm exec wrangler login
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put GITHUB_BOT_TOKEN   # 或配置 GITHUB_APP_* 三个变量

pnpm run deploy
```

审校台按作品提交 SHA 核对数据仓 `pr-preview.yml` 的成功运行。修改后先保存，新提交检查通过后再次批准。斜杠命令使用默认令牌推送时，Worker 还可核对 `pr-command.yml` 成功运行上传的对应版本校验记录。如果分支保护要求投稿 PR 工作流在斜杠指令生成的新提交上重新运行，可在数据仓设置仅具有该仓 Contents 写入权限的 `PR_PUSH_TOKEN`。GitHub 分支保护仍照常执行。

首次发布此版本时 Wrangler 会按配置创建免费的 SQLite Durable Object，用于登录 ticket 的跨实例一次性兑换。单次网页投稿或编辑的文件总量（含缩略图）上限为 4 MiB。

将输出的 `*.workers.dev` 地址填入数据仓库 `site.config.json` 的 `workerApiUrl`。
