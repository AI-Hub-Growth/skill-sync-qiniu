# skill-sync-qiniu

将任意 skill 仓库（含 `SKILL.md` 的目录）打包上传到七牛云 OSS，并生成供 `import-skills.mjs` 使用的 NDJSON manifest。

支持本地目录和远程 GitHub 仓库两种来源，可通过 GitHub Actions 定时自动同步。

## 依赖

- Node.js 18+ 或 Bun
- 系统 `zip` 命令

无需 `package.json`，仅使用 Node.js/Bun 内置模块。

## 快速开始

```bash
# 配置环境变量
export QINIU_ACCESS_KEY=your_access_key
export QINIU_SECRET_KEY=your_secret_key
export QINIU_BUCKET=your_bucket
export QINIU_DOWNLOAD_DOMAIN=https://cdn.example.com
export QINIU_AUTHOR=your_name

# 预览（不上传）
node sync.mjs --root /path/to/skills --dry-run

# 正式同步（本地目录）
node sync.mjs --root /path/to/skills --changelog "Initial release"

# 从远程 GitHub 来源同步
node sync.mjs --sources sources.json --dry-run
node sync.mjs --sources sources.json --bump patch

# 或使用 Shell 入口
chmod +x sync.sh
./sync.sh --sources sources.json
```

## 远程来源（sources.json）

在 `sources.json` 中维护 GitHub skill 来源列表：

```json
[
  {
    "url": "https://github.com/JimLiu/baoyu-skills/tree/main/skills"
  },
  {
    "url": "https://github.com/user/repo/tree/main/skills/single-skill",
    "prefix": "custom",
    "slug": "override-slug"
  }
]
```

- `url`（必填）：GitHub 目录 URL，格式 `https://github.com/{owner}/{repo}/tree/{branch}/{path}`
- `prefix`（可选）：slug 前缀，避免不同仓库的同名 skill 冲突。**不填时自动取 URL 中的 owner**，如 `jimliu-image-gen`；设为 `""` 可禁用前缀
- `slug`（可选）：仅单 skill 模式时有效，显式指定完整 slug（不受 prefix 影响）

**自动检测模式：**
- URL 对应目录下有 `SKILL.md` → **单 skill 模式**
- URL 对应目录下没有 `SKILL.md` → **集合模式**（遍历直接子目录，每个含 `SKILL.md` 的子目录作为独立 skill）

**变更检测：** 先通过 GitHub Tree API 计算轻量级指纹，指纹未变化则跳过下载，避免每次全量拉取。

## 定时自动同步（GitHub Actions）

将仓库推送到 GitHub 后，`.github/workflows/sync-remote.yml` 会每天 UTC 02:00（北京时间 10:00）自动运行。

**配置 Secrets：** 在仓库 Settings → Secrets and variables → Actions 中添加：
- `QINIU_ACCESS_KEY`、`QINIU_SECRET_KEY`、`QINIU_BUCKET`、`QINIU_DOWNLOAD_DOMAIN`
- 可选：`QINIU_AUTHOR`、`QINIU_PRIVATE`、`QINIU_AI_API_KEY`

`GITHUB_TOKEN` 由 GitHub Actions 自动注入，无需手动配置。

也可在 Actions 页面手动触发，支持选择 bump 类型和 dry-run 模式。

## 输出产物

1. 七牛 bucket：`{slug}/{slug}-{version}.zip`
2. 七牛 bucket：`registry.json`（版本注册表）
3. 本地：`skills-manifest.ndjson`（供 `import-skills.mjs` 使用）

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `QINIU_ACCESS_KEY` | Access Key | ✓ |
| `QINIU_SECRET_KEY` | Secret Key | ✓ |
| `QINIU_BUCKET` | Bucket 名称 | ✓ |
| `QINIU_DOWNLOAD_DOMAIN` | 下载域名 | ✓ |
| `QINIU_UPLOAD_URL` | 上传端点（默认 `https://up.qiniup.com`） | |
| `QINIU_PRIVATE` | 私有 bucket（默认 `true`） | |
| `QINIU_AUTHOR` | author 字段 fallback（git remote 解析失败时使用） | |
| `QINIU_AI_API_KEY` | 七牛 AI API Key，用于中文翻译 | |
| `GITHUB_TOKEN` | GitHub token，提升 API 限速至 5000 次/小时（本地可选，Actions 自动注入） | |

区域上传端点：`z0=up-z0.qiniup.com`，`z1=up-z1.qiniup.com`，`z2=up-z2.qiniup.com`

## CLI 参数

```
--root <dir>              skill 根目录（可重复，默认 ./skills）
--sources <file>          远程来源 JSON 文件（默认自动加载 ./sources.json）
--dry-run                 预览，不上传
--bump patch|minor|major  版本升级类型（默认 patch）
--changelog <text>        变更说明
--output <file>           manifest 输出路径（默认 ./skills-manifest.ndjson）
--concurrency <n>         并发数 1-32（默认 4）
-h, --help                显示帮助
```

## 与 import-skills.mjs 集成

生成 manifest 后，在 `clawskills/` 目录运行：

```bash
node scripts/import-skills.mjs --mode upsert /path/to/skills-manifest.ndjson
```

## registry.json 格式

```json
{
  "skills": {
    "baoyu-image-gen": {
      "version": "1.0.3",
      "fingerprint": "abc123...",
      "remote_fingerprint": "def456...",
      "source_url": "https://github.com/user/repo",
      "changelog": "Add new feature",
      "updatedAt": "2026-03-12T10:00:00Z",
      "name": "Baoyu Image Gen",
      "description": "AI image generation...",
      "name_zh": "宝玉图片生成",
      "description_zh": "AI 图片生成..."
    }
  }
}
```
