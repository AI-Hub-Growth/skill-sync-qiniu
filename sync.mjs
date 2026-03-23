#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

await loadDotEnv(path.join(import.meta.dirname, ".env"));

const TEXT_EXTENSIONS = new Set([
  "md", "mdx", "txt", "json", "json5", "yaml", "yml", "toml",
  "js", "cjs", "mjs", "ts", "tsx", "jsx", "py", "sh", "rb",
  "go", "rs", "swift", "kt", "java", "cs", "cpp", "c", "h",
  "hpp", "sql", "csv", "ini", "cfg", "env", "xml", "html",
  "css", "scss", "sass", "svg",
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const accessKey = requireEnv("QINIU_ACCESS_KEY");
  const secretKey = requireEnv("QINIU_SECRET_KEY");
  const bucket = requireEnv("QINIU_BUCKET");
  const uploadUrl = process.env.QINIU_UPLOAD_URL || "https://up.qiniup.com";
  const downloadDomain = requireEnv("QINIU_DOWNLOAD_DOMAIN").replace(/\/+$/, "");
  const isPrivate = (process.env.QINIU_PRIVATE || "true") === "true";
  const aiApiKey = process.env.QINIU_AI_API_KEY || "";
  const authorFallback = process.env.QINIU_AUTHOR || "";
  const githubToken = process.env.GITHUB_TOKEN || "";

  const qiniu = { accessKey, secretKey, bucket, uploadUrl, downloadDomain, isPrivate };

  const roots = options.roots.length > 0 ? options.roots : [path.resolve("skills")];
  const skills = await findSkills(roots);

  const locals = await mapWithConcurrency(skills, options.concurrency, async (skill) => {
    const files = await listTextFiles(skill.folder);
    const fingerprint = buildFingerprint(files);
    const meta = await parseSkillMeta(skill.folder);
    const { author, repoUrl } = await resolveGitInfo(skill.folder, authorFallback);
    return { ...skill, fileCount: files.length, fingerprint, meta, author, repoUrl };
  });

  const registry = await fetchRegistry(qiniu);

  const localCandidates = locals.map((skill) => {
    const entry = registry.skills?.[skill.slug];
    if (!entry) return { ...skill, status: "new", latestVersion: null };
    if (entry.fingerprint === skill.fingerprint) return { ...skill, status: "synced", latestVersion: entry.version };
    return { ...skill, status: "update", latestVersion: entry.version };
  });

  const sourcesFile = options.sourcesFile ?? path.resolve("sources.json");
  const sources = await loadSources(sourcesFile);
  const remoteSkillArrays = sources.length > 0
    ? await mapWithConcurrency(sources, options.concurrency, (src) =>
        resolveRemoteSource(src, registry, githubToken, authorFallback).catch((err) => {
          console.warn(`  WARN: skip remote source ${src.url}: ${err.message}`);
          return [];
        }))
    : [];
  const remoteCandidates = remoteSkillArrays.flat().filter(Boolean);

  const candidateMap = new Map();
  for (const c of localCandidates) candidateMap.set(c.slug, c);
  for (const c of remoteCandidates) candidateMap.set(c.slug, c);
  const candidates = [...candidateMap.values()].sort((a, b) => a.slug.localeCompare(b.slug));

  if (candidates.length === 0) {
    throw new Error("No skills found.");
  }

  console.log("Qiniu skill sync");
  console.log(`Roots: ${roots.join(", ")}`);
  if (sources.length > 0) console.log(`Remote sources: ${sources.length}`);
  console.log(`Skills found: ${candidates.length}`);

  const actionable = candidates.filter((c) => c.status !== "synced");

  console.log("");
  if (actionable.length === 0) {
    console.log("Nothing to sync.");
  } else {
    console.log("To sync:");
    for (const c of actionable) {
      const nextVer = c.status === "new" ? "1.0.0" : bumpSemver(c.latestVersion, options.bump);
      console.log(`  ${c.slug}  ${c.status.toUpperCase()}  ${c.latestVersion ?? "-"} -> ${nextVer}  (${c.fileCount} files)`);
    }
  }

  if (options.dryRun) {
    console.log("");
    console.log(`Dry run: would upload ${actionable.length} skill(s).`);
    for (const c of actionable) await c._cleanup?.();
    return;
  }

  for (const candidate of actionable) {
    const version = candidate.status === "new" ? "1.0.0" : bumpSemver(candidate.latestVersion, options.bump);
    console.log(`\nUploading ${candidate.slug}@${version}...`);

    let nameZh = registry.skills?.[candidate.slug]?.name_zh || "";
    let descZh = registry.skills?.[candidate.slug]?.description_zh || "";

    if (aiApiKey) {
      if (candidate.meta.name) {
        nameZh = await translateToChinese(candidate.meta.name, aiApiKey);
      }
      if (candidate.meta.description) {
        descZh = await translateToChinese(candidate.meta.description, aiApiKey);
      }
    }

    const zipPath = await zipSkill(candidate.slug, candidate.folder);
    const key = `${candidate.slug}/${candidate.slug}-${version}.zip`;
    await uploadFile(qiniu, key, zipPath);
    await fs.rm(zipPath, { force: true });
    await candidate._cleanup?.();

    if (!registry.skills) registry.skills = {};
    registry.skills[candidate.slug] = {
      version,
      fingerprint: candidate.fingerprint,
      ...(candidate.remoteFingerprint && { remote_fingerprint: candidate.remoteFingerprint }),
      changelog: options.changelog,
      updatedAt: new Date().toISOString(),
      name: candidate.meta.name || titleCase(candidate.slug),
      description: candidate.meta.description || "",
      name_zh: nameZh,
      description_zh: descZh,
      ...(candidate.repoUrl && { source_url: candidate.repoUrl }),
    };

    console.log(`OK ${candidate.slug}@${version}`);
  }

  if (actionable.length > 0) {
    await uploadRegistry(qiniu, registry);
    console.log("\nRegistry updated.");
  }

  const allCandidates = candidates;
  const lines = allCandidates.map((c) => {
    const entry = registry.skills?.[c.slug];
    const version = entry?.version || c.latestVersion || "1.0.0";
    const downloadUrl = `${downloadDomain}/${c.slug}/${c.slug}-${version}.zip`;
    const name = entry?.name_zh || entry?.name || c.meta?.name || titleCase(c.slug);
    const description = entry?.description_zh || entry?.description || c.meta?.description || "";
    return JSON.stringify({
      slug: c.slug,
      name,
      author: c.author || "",
      description,
      stars: "0",
      downloads: "0",
      versions: version,
      installs_current: 0,
      installs_all_time: 0,
      source_url: c.repoUrl || "",
      detail: entry?.changelog || options.changelog || "Initial release",
      download_url: downloadUrl,
    });
  });

  await fs.writeFile(options.output, lines.join("\n") + "\n", "utf8");
  console.log(`\nManifest written: ${options.output} (${lines.length} skills)`);
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env: ${name}`);
  return val;
}

function parseArgs(argv) {
  const options = {
    roots: [],
    dryRun: false,
    bump: "patch",
    changelog: "",
    output: path.resolve("skills-manifest.ndjson"),
    concurrency: 4,
    sourcesFile: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "-h" || arg === "--help") { printUsage(); process.exit(0); }
    if (arg === "--root") {
      const val = argv[++i];
      if (!val) throw new Error("--root requires a directory");
      options.roots.push(path.resolve(val));
      continue;
    }
    if (arg === "--bump") {
      const val = argv[++i];
      if (!["patch", "minor", "major"].includes(val)) throw new Error("--bump must be patch, minor, or major");
      options.bump = val;
      continue;
    }
    if (arg === "--changelog") {
      const val = argv[++i];
      if (val == null) throw new Error("--changelog requires text");
      options.changelog = val;
      continue;
    }
    if (arg === "--output") {
      const val = argv[++i];
      if (!val) throw new Error("--output requires a path");
      options.output = path.resolve(val);
      continue;
    }
    if (arg === "--concurrency") {
      const val = Number(argv[++i]);
      if (!Number.isInteger(val) || val < 1 || val > 32) throw new Error("--concurrency must be 1-32");
      options.concurrency = val;
      continue;
    }
    if (arg === "--sources") {
      const val = argv[++i];
      if (!val) throw new Error("--sources requires a file path");
      options.sourcesFile = path.resolve(val);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage() {
  console.log(`Usage: node sync.mjs [options]

Options:
  --root <dir>              Skill root directory (repeatable, default: ./skills)
  --dry-run                 Preview without uploading
  --bump patch|minor|major  Version bump type (default: patch)
  --changelog <text>        Changelog text
  --output <file>           Manifest output path (default: ./skills-manifest.ndjson)
  --concurrency <n>         Concurrency 1-32 (default: 4)
  --sources <file>          Remote sources JSON (default: ./sources.json if exists)
  -h, --help                Show help

Required env vars:
  QINIU_ACCESS_KEY          Qiniu access key
  QINIU_SECRET_KEY          Qiniu secret key
  QINIU_BUCKET              Qiniu bucket name
  QINIU_DOWNLOAD_DOMAIN     Download domain (e.g. https://cdn.example.com)
  QINIU_AUTHOR              Author name for manifest

Optional env vars:
  QINIU_UPLOAD_URL          Upload endpoint (default: https://up.qiniup.com)
  QINIU_PRIVATE             Private bucket true/false (default: true)
  QINIU_AI_API_KEY          Qiniu AI API key for Chinese translation
  GITHUB_TOKEN              GitHub token for higher API rate limits`);
}

async function findSkills(roots) {
  const deduped = new Map();
  for (const root of roots) {
    const folders = await findSkillFolders(root);
    for (const folder of folders) {
      deduped.set(folder.slug, folder);
    }
  }
  return [...deduped.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

async function findSkillFolders(root) {
  const stat = await safeStat(root);
  if (!stat?.isDirectory()) return [];

  if (await hasSkillMarker(root)) {
    return [buildSkillEntry(root)];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(root, entry.name);
    if (await hasSkillMarker(folder)) {
      found.push(buildSkillEntry(folder));
    }
  }
  return found;
}

function buildSkillEntry(folder) {
  const base = path.basename(folder);
  return { folder, slug: sanitizeSlug(base), displayName: titleCase(base) };
}

async function hasSkillMarker(folder) {
  return Boolean(
    (await safeStat(path.join(folder, "SKILL.md")))?.isFile() ||
    (await safeStat(path.join(folder, "skill.md")))?.isFile()
  );
}

async function listTextFiles(root) {
  const files = [];

  async function walk(folder) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;

      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(fullPath); continue; }
      if (!entry.isFile()) continue;

      const relPath = path.relative(root, fullPath).split(path.sep).join("/");
      const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
      if (!TEXT_EXTENSIONS.has(ext)) continue;

      const bytes = await fs.readFile(fullPath);
      files.push({ relPath, bytes });
    }
  }

  await walk(root);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function buildFingerprint(files) {
  const payload = files
    .map((f) => `${f.relPath}:${sha256(f.bytes)}`)
    .sort((a, b) => a.localeCompare(b))
    .join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function parseSkillMeta(folder) {
  const skillPath = path.join(folder, "SKILL.md");
  const skillPathLower = path.join(folder, "skill.md");
  let content = "";
  try {
    content = await fs.readFile(skillPath, "utf8");
  } catch {
    try {
      content = await fs.readFile(skillPathLower, "utf8");
    } catch {
      return { name: "", description: "" };
    }
  }

  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { name: "", description: "" };

  const meta = { name: "", description: "" };
  let inFrontMatter = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === "---") { inFrontMatter = true; continue; }
    if (inFrontMatter && line.trim() === "---") break;
    if (!inFrontMatter) continue;

    const nameMatch = /^name\s*:\s*(.+)$/.exec(line);
    if (nameMatch) { meta.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, ""); continue; }

    const descMatch = /^description\s*:\s*(.+)$/.exec(line);
    if (descMatch) { meta.description = descMatch[1].trim().replace(/^['"]|['"]$/g, ""); }
  }

  return meta;
}

async function resolveGitInfo(skillFolder, fallback) {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: skillFolder,
    });
    const url = stdout.trim();

    const httpsMatch = /https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (httpsMatch) {
      const [, host, user, repo] = httpsMatch;
      return { author: user, repoUrl: `https://${host}/${user}/${repo}` };
    }

    const sshMatch = /git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (sshMatch) {
      const [, host, user, repo] = sshMatch;
      return { author: user, repoUrl: `https://${host}/${user}/${repo}` };
    }
  } catch {}
  return { author: fallback, repoUrl: "" };
}

async function fetchRegistry(qiniu) {  try {
    const url = buildDownloadUrl(qiniu, "registry.json");
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (res.status === 404) return { skills: {} };
    if (!res.ok) throw new Error(`Failed to fetch registry: HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.message?.includes("Failed to fetch registry")) throw err;
    return { skills: {} };
  }
}

function qiniuBase64(buf) {
  return buf.toString("base64").replace(/\//g, "_").replace(/\+/g, "-");
}

function buildDownloadUrl(qiniu, key) {
  const baseUrl = `${qiniu.downloadDomain}/${key}`;
  if (!qiniu.isPrivate) return baseUrl;

  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const urlWithExpiry = `${baseUrl}?e=${deadline}`;
  const sign = crypto.createHmac("sha1", qiniu.secretKey)
    .update(urlWithExpiry)
    .digest();
  const token = `${qiniu.accessKey}:${qiniuBase64(sign)}`;
  return `${urlWithExpiry}&token=${token}`;
}

function buildUploadToken(qiniu, key) {
  const putPolicy = JSON.stringify({
    scope: `${qiniu.bucket}:${key}`,
    deadline: Math.floor(Date.now() / 1000) + 3600,
  });
  const encodedPutPolicy = qiniuBase64(Buffer.from(putPolicy));
  const sign = crypto.createHmac("sha1", qiniu.secretKey)
    .update(encodedPutPolicy)
    .digest();
  const encodedSign = qiniuBase64(sign);
  return `${qiniu.accessKey}:${encodedSign}:${encodedPutPolicy}`;
}

async function uploadFile(qiniu, key, filePath) {
  const token = buildUploadToken(qiniu, key);
  const fileBytes = await fs.readFile(filePath);

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.set("token", token);
      form.set("key", key);
      form.set("file", new Blob([fileBytes]), path.basename(filePath));

      const res = await fetch(qiniu.uploadUrl, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(300000),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed for ${key}: HTTP ${res.status} ${text}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        console.warn(`  Upload attempt ${attempt} failed for ${key}: ${err.message}, retrying...`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }
  throw lastErr;
}

async function uploadRegistry(qiniu, registry) {
  const token = buildUploadToken(qiniu, "registry.json");
  const content = JSON.stringify(registry, null, 2);

  const form = new FormData();
  form.set("token", token);
  form.set("key", "registry.json");
  form.set("file", new Blob([content], { type: "application/json" }), "registry.json");

  const res = await fetch(qiniu.uploadUrl, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Registry upload failed: HTTP ${res.status} ${text}`);
  }
}

async function zipSkill(slug, folder) {
  const zipPath = path.join(os.tmpdir(), `${slug}-${Date.now()}.zip`);
  await execFileAsync("zip", ["-r", zipPath, "."], { cwd: folder });
  return zipPath;
}

async function translateToChinese(text, aiApiKey) {
  try {
    const res = await fetch("https://api.qnaigc.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiApiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v3",
        stream: false,
        max_tokens: 256,
        messages: [{ role: "user", content: `翻译成中文，只输出翻译结果，不要解释：${text}` }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  const count = Math.min(Math.max(limit, 1), Math.max(items.length, 1));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

function bumpSemver(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) throw new Error(`Invalid semver: ${version}`);
  const [, maj, min, pat] = match.map(Number);
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function sanitizeSlug(value) {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "").replace(/-+$/, "").replace(/--+/g, "-");
}

function titleCase(value) {
  return value.trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function safeStat(filePath) {
  try { return await fs.stat(filePath); } catch { return null; }
}

async function loadDotEnv(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// ── Remote source helpers ───────────────────────────────────────────────────

function parseGitHubUrl(urlStr) {
  const cleaned = urlStr.trim().replace(/\/+$/, "");
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/.exec(cleaned);
  if (!match) {
    throw new Error(`Invalid GitHub URL (expected https://github.com/{owner}/{repo}/tree/{branch}/{path}): ${urlStr}`);
  }
  const [, owner, repo, ref, skillPath] = match;
  return { owner, repo, ref, skillPath };
}

async function fetchGitHubTree(owner, repo, ref, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const headers = { Accept: "application/vnd.github.v3+json", "User-Agent": "skill-sync-qiniu" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`GitHub Tree API error HTTP ${res.status} for ${owner}/${repo}@${ref}`);
  const data = await res.json();
  if (data.truncated) console.warn(`  WARN: GitHub tree truncated for ${owner}/${repo}`);
  return data.tree || [];
}

async function downloadGitHubSkill(parsed, token, tree) {
  const { owner, repo, ref, skillPath } = parsed;
  const prefix = skillPath + "/";
  const blobs = tree.filter((item) => item.type === "blob" && item.path.startsWith(prefix));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-sync-"));

  await mapWithConcurrency(blobs, 4, async (blob) => {
    const relPath = blob.path.slice(prefix.length);
    const localPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${blob.path}`;
    const headers = { "User-Agent": "skill-sync-qiniu" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(rawUrl, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Failed to fetch ${blob.path}: HTTP ${res.status}`);
    await fs.writeFile(localPath, Buffer.from(await res.arrayBuffer()));
  });

  return tmpDir;
}

async function loadSources(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw new Error(`Failed to load sources from ${filePath}: ${err.message}`);
  }
}

async function resolveRemoteSource(source, registry, token, fallback) {
  const parsed = parseGitHubUrl(source.url);
  const repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
  const tree = await fetchGitHubTree(parsed.owner, parsed.repo, parsed.ref, token);
  const pathPrefix = parsed.skillPath + "/";

  const pfx = source.prefix !== undefined ? source.prefix : sanitizeSlug(parsed.owner);
  const makeSlug = (name) =>
    sanitizeSlug(pfx ? `${pfx}-${name}` : name);

  const hasRootMarker = tree.some(
    (item) => item.type === "blob" &&
      (item.path === `${parsed.skillPath}/SKILL.md` || item.path === `${parsed.skillPath}/skill.md`)
  );

  if (hasRootMarker) {
    const baseName = parsed.skillPath.split("/").pop();
    const slug = source.slug ? sanitizeSlug(source.slug) : makeSlug(baseName);
    return [await resolveOneRemoteSkill({ ...parsed, slug }, tree, repoUrl, registry, token, fallback)];
  }

  // Collection mode: enumerate direct subdirs that have SKILL.md
  const subdirs = new Set();
  for (const item of tree) {
    if (item.type !== "blob" || !item.path.startsWith(pathPrefix)) continue;
    const rel = item.path.slice(pathPrefix.length);
    if (!rel.includes("/")) continue;
    subdirs.add(rel.split("/")[0]);
  }

  const skills = [];
  for (const subdir of [...subdirs].sort()) {
    const subdirPath = `${parsed.skillPath}/${subdir}`;
    const hasMarker = tree.some(
      (item) => item.type === "blob" &&
        (item.path === `${subdirPath}/SKILL.md` || item.path === `${subdirPath}/skill.md`)
    );
    if (!hasMarker) continue;
    skills.push(
      await resolveOneRemoteSkill(
        { ...parsed, skillPath: subdirPath, slug: makeSlug(subdir) },
        tree, repoUrl, registry, token, fallback
      )
    );
  }
  return skills;
}

async function resolveOneRemoteSkill(parsed, tree, repoUrl, registry, token, fallback) {
  const { slug, skillPath, owner } = parsed;
  const prefix = skillPath + "/";

  const entries = tree
    .filter((item) => item.type === "blob" && item.path.startsWith(prefix))
    .map((item) => `${item.path.slice(prefix.length)}:${item.sha}`)
    .sort();
  const remoteFingerprint = crypto.createHash("sha256").update(entries.join("\n")).digest("hex");

  const entry = registry.skills?.[slug];
  if (entry && entry.remote_fingerprint === remoteFingerprint) {
    return {
      slug, folder: null,
      fingerprint: entry.fingerprint || "",
      remoteFingerprint,
      meta: { name: entry.name || "", description: entry.description || "" },
      author: fallback || owner,
      repoUrl, fileCount: 0,
      status: "synced", latestVersion: entry.version,
      _cleanup: async () => {},
    };
  }

  const tmpDir = await downloadGitHubSkill(parsed, token, tree);
  const _cleanup = async () => {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  };

  try {
    const files = await listTextFiles(tmpDir);
    const fingerprint = buildFingerprint(files);
    const meta = await parseSkillMeta(tmpDir);
    return {
      slug, folder: tmpDir,
      fingerprint, remoteFingerprint,
      meta, author: fallback || owner, repoUrl,
      fileCount: files.length,
      status: entry ? "update" : "new",
      latestVersion: entry?.version ?? null,
      _cleanup,
    };
  } catch (err) {
    await _cleanup();
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
