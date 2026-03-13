# skill-sync-qiniu

将任意 skill 仓库（含 `SKILL.md` 的目录）打包上传到七牛云 OSS，并生成供 `import-skills.mjs` 使用的 NDJSON manifest。

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

# 正式同步
node sync.mjs --root /path/to/skills --changelog "Initial release"

# 或使用 Shell 入口
chmod +x sync.sh
./sync.sh --root /path/to/skills
```

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

区域上传端点：`z0=up-z0.qiniup.com`，`z1=up-z1.qiniup.com`，`z2=up-z2.qiniup.com`

## CLI 参数

```
--root <dir>              skill 根目录（可重复，默认 ./skills）
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
