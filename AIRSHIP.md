# Airship fork of Portkey-AI/gateway

This fork exists so Airship controls the code and the dependency lockfile of the gateway it vendors
(`services/portkey` in the Airship repo pins a tag and its commit).

## Branches

- `main` — upstream `main` plus Airship's commits. It is the default branch, so Dependabot alerts and the
  `airship` workflow describe exactly what Airship vendors. Changes land here through PRs; releases are cut from it.
- `airship` — retired (it was `main` plus our commits while `main` mirrored upstream). Old tags stay reachable.

## Releases

Tags are `v<upstream version>-airship.<n>` (e.g. `v1.15.2-airship.6`): the upstream `package.json` version the
branch is based on, plus our revision. Tag a commit on `main`. Consumers pin a tag **and** its commit SHA.

## Syncing with upstream

```bash
git remote add upstream https://github.com/Portkey-AI/gateway.git   # once
git fetch upstream && git switch -c chore/sync-upstream main
git merge upstream/main                       # merge, not rebase: released tags stay reachable
npm audit fix                                 # non-forced; lockfile only
npm audit --omit=dev                          # runtime deps must report 0
grep -rn "from 'zod'" src plugins             # only src/amc/zod.ts may import zod directly
# PR into main; after it merges:
git tag -a v<version>-airship.<n> -m '...' && git push origin --tags
```

## Deviations from upstream

- `src/amc/` — Airship's egress pins (every upstream fetch goes through `amcFetch`) and the zod re-export below.
- `package-lock.json` — `npm audit fix` (non-forced).
- `package.json`:
  - `patch-package` moved from `dependencies` to `devDependencies`. It is a postinstall tool, not runtime code;
    `npm ci` still installs it. Keeps `npm audit --omit=dev` clean (its `braces` chain has no published fix).
  - `zod` 4 (upstream: 3; GHSA-mrhx-c7xc-m3w5 is fixed only in 4.6.6+). The three files that use zod import it
    from `src/amc/zod.ts`, which re-exports the members by name: zod 4's `z` namespace object would keep
    ~650 KB of unused zod in the worker bundle. `z.record` takes a key schema in zod 4. Built-in error messages
    changed wording (`Invalid input: expected number, received string`); pass/fail and error paths did not.
  - `@hono/node-server` 2 (upstream: 1; GHSA-rmxm-3fg6-px4f is fixed only in 2.1.3+), with an `overrides` entry
    because `@hono/node-ws` still declares a `^1` peer. Both are used only by the Node entry
    (`src/start-server.ts`), never by the worker.
