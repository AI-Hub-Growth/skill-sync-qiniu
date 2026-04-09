# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Node.js/Bun utility for packaging skills and syncing them to Qiniu. Core logic lives in [`sync.mjs`](/Users/tibelf/Github/skill-sync-qiniu/sync.mjs), which handles CLI parsing, skill discovery, fingerprinting, zipping, upload, and manifest generation. [`sync.sh`](/Users/tibelf/Github/skill-sync-qiniu/sync.sh) is the shell entrypoint that selects `node` or `bun`. Configuration samples live in [`.env.template`](/Users/tibelf/Github/skill-sync-qiniu/.env.template); remote skill sources are listed in [`sources.json`](/Users/tibelf/Github/skill-sync-qiniu/sources.json). Generated output is written to [`skills-manifest.ndjson`](/Users/tibelf/Github/skill-sync-qiniu/skills-manifest.ndjson). CI automation is defined in [`.github/workflows/sync-remote.yml`](/Users/tibelf/Github/skill-sync-qiniu/.github/workflows/sync-remote.yml).

## Build, Test, and Development Commands
Use Node.js 18+ or Bun, plus the system `zip` command.

- `node sync.mjs --help`: show CLI options and required environment variables.
- `node sync.mjs --root /path/to/skills --dry-run`: preview local skill discovery and version changes without upload.
- `node sync.mjs --sources sources.json --bump patch`: sync configured remote GitHub sources.
- `./sync.sh --sources sources.json`: run the same flow through the shell wrapper.

There is no separate build step or package manager bootstrap in this repository.

## Coding Style & Naming Conventions
Follow the existing style in [`sync.mjs`](/Users/tibelf/Github/skill-sync-qiniu/sync.mjs): ES modules, `async`/`await`, two-space indentation, semicolons, and double quotes. Prefer small focused helpers over large inline blocks. Use clear camelCase names for functions and variables (`parseArgs`, `findSkillFolders`), and kebab-case for filenames (`sync-remote.yml`). Keep CLI flags long-form and explicit, such as `--dry-run` and `--sources`.

## Testing Guidelines
This repo currently has no automated test suite. Validate changes with targeted dry runs:

- `node sync.mjs --root /tmp/skills --dry-run`
- `node sync.mjs --sources sources.json --dry-run`

When changing upload, manifest, or versioning logic, verify the generated NDJSON shape and confirm error paths remain readable.

## Commit & Pull Request Guidelines
Recent history favors short conventional commits such as `fix: increase upload timeout...`, `feat: support remote GitHub sources...`, and `chore: update skills-manifest.ndjson [skip ci]`. Prefer `feat:`, `fix:`, and `chore:` prefixes with a concise imperative summary.

Pull requests should explain the user-visible behavior change, list verification commands, and note any required env or workflow updates. Include sample manifest or CLI output when behavior changes are easier to review from concrete examples.
