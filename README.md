# `danielroe/provenance-action`

Fail CI when dependencies in your lockfile lose npm provenance, trusted publisher or staged publishing status.

> [!WARNING]
> This action is under active development and is only one tool to assist in securing your dependencies.

> [!NOTE]
> **pnpm users:** As of [pnpm v10.21](https://github.com/pnpm/pnpm/releases/tag/v10.21.0), pnpm now has built-in support for `trustPolicy` in `.npmrc`, which provides native enforcement of provenance checks. If you're using pnpm v10.21 or later, you may not need this action. See the [pnpm documentation](https://pnpm.io/blog/releases/10.21#trust-policy) for more details.

## ✨ Features
- supports `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` (v1 and v2+), `bun.lock`
- handles transitives by comparing resolved versions
- inline GitHub annotations at the lockfile line
- JSON output and optional hard‑fail (default: on)
- pure TypeScript, Node 24+

👉 See it in action: [danielroe/provenance-action-test](https://github.com/danielroe/provenance-action-test)

## 🚀 Quick start
```yaml
name: ci
on:
  pull_request:
    branches:
      - main
    paths:
      # Trigger a run only on PRs that change the lockfile
      # (keep whichever is relevant and/or configure its path):
      - pnpm-lock.yaml
      - package-lock.json
      - yarn.lock
      - bun.lock

permissions:
  contents: read
jobs:
  check-provenance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Check provenance downgrades
        uses: danielroe/provenance-action@main
        id: check
        with:
          fail-on-provenance-change: true # optional, default: false
        #   lockfile: pnpm-lock.yaml      # optional
        #   base-ref: origin/main         # optional, default: origin/main
        #   fail-on-downgrade: true       # optional, default: true
      - name: Print result
        run: "echo 'Downgraded: ${{ steps.check.outputs.downgraded }}'"
```

## 🔧 Inputs
- `lockfile` (optional): Path to the lockfile. Auto-detected if omitted.
- `workspace-path` (optional): Path to workspace root. Default: `.`
- `base-ref` (optional): Git ref to compare against. Default: `origin/main`.
- `fail-on-downgrade` (optional): Controls failure behavior. Accepts `true`, `false`, `any`, or `only-provenance-loss`. Default: `true` (which is the same as `any`).
- `fail-on-provenance-change` (optional): When `true`, fail on provenance repository/branch changes. Default: `false`.

## 📤 Outputs
- `downgraded`: JSON array of `{ name, from, to, downgradeType }` for detected downgrades. `downgradeType` is `provenance`, `trusted_publisher` or `staged_publish`.
- `changed`: JSON array of provenance change events `{ name, from, to, type, previousRepository?, newRepository?, previousBranch?, newBranch? }`.

## 🧠 How it works
1. Diffs your lockfile against the base ref and collects changed resolved versions (including transitives).
2. Checks npm provenance via the attestations API for each `name@version`.
3. Falls back to version metadata for `dist.attestations`.
4. Emits file+line annotations in the lockfile.
5. If provenance exists for both the previous and new version, extracts GitHub `owner/repo` and branch from attestations and warns when they differ (repo changed or branch changed).

## 🔒 Why this matters
Trusted publishing links a package back to its source repo and build workflow, providing strong provenance guarantees. It helps ensure the package you install corresponds to audited source and CI.

However, maintainers can still be phished or coerced into publishing without trusted publishing enabled, or switching to a non‑trusted path. In those cases, packages may still carry attestations, but the chain back to the trusted publisher can be weakened.

This action:
- Detects when a dependency update loses npm provenance (no attestations), loses trusted publisher (attestations but no trusted publisher marker), or loses [staged publishing](https://docs.npmjs.com/staged-publishing) (previous version was published via a staged release with a recorded approver; new version was not), and
- Fails CI by default (configurable), before that change lands in your main branch.

This is a stopgap until package managers enforce stronger policies natively. Until then, it offers a lightweight guardrail in CI.

## ⚠️ Notes
- Runs on Node 24+ and executes the TypeScript entrypoint directly.
- `bun.lockb` is not supported. (You can generate a `bun.lock` with `bun install --save-text-lockfile`.)
- Repository and branch change detection is best‑effort; attestation shapes vary and some packages omit repo/ref details.
