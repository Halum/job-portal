#!/bin/sh
# Installs the husky hooks for THIS worktree only.
# `husky` writes core.hooksPath into the shared .git/config, which would point every other
# worktree and checkout of this repo at a .husky/ they may not have. So run husky to generate
# .husky/_, then move the setting into the per-worktree config.
set -e
git rev-parse --git-dir >/dev/null 2>&1 || exit 0   # not a git checkout (for example a tarball): nothing to install
pnpm exec husky >/dev/null
git config --unset core.hooksPath || true
git config extensions.worktreeConfig true
git config --worktree core.hooksPath .husky/_
