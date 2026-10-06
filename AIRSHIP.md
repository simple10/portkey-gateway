# Airship fork of Portkey-AI/gateway

This fork exists so Airship controls the dependency lockfile of the gateway it vendors.

## Branches

- `main` — a pure mirror of `Portkey-AI/gateway` `main`. Never commit here.
- `airship` — `main` plus Airship's commits. Releases are cut from this branch.

## Releases

Tags are `v<upstream version>-airship.<n>` (e.g. `v1.15.2-airship.1`): the upstream
`package.json` version the branch is based on, plus our revision. Consumers pin a tag
**and** its commit SHA.

## Syncing with upstream

```bash
git remote add upstream https://github.com/Portkey-AI/gateway.git   # once
git fetch upstream && git switch main && git merge --ff-only upstream/main && git push origin main
git switch airship && git merge main          # merge, not rebase — old tags stay reachable
npm audit fix                                 # non-forced; lockfile only
npm audit --omit=dev                          # runtime deps must report 0
git tag -a v<version>-airship.<n> -m '...' && git push origin airship --follow-tags
```

## Deviations from upstream

- `package-lock.json` — `npm audit fix` (non-forced).
- `package.json` — `patch-package` moved from `dependencies` to `devDependencies`. It is a
  postinstall tool, not runtime code; `npm ci` still installs it. Keeps `npm audit --omit=dev` clean
  (its `braces` chain has no published fix).
