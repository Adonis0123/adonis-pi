#!/bin/sh
# Scans everything git would publish (tracked + untracked, not ignored) for secrets and private layout.
# Exit 0 = clean, 1 = findings, 2 = a stray account-layer file is not ignored.
set -u
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
home_prefix=$(printf '/%s/' Users)
# Each alternative is a complete credential shape or a private-layout marker, never a bare prefix.
pattern="${home_prefix}[A-Za-z0-9._-]+/|sk-[A-Za-z0-9_-]{16,}|[0-9a-f]{32}\.[A-Za-z0-9]{16}|ou_[a-z0-9]{8,}|oc_[a-z0-9]{8,}|hooks\.slack\.com/services/[A-Za-z0-9/]+|open\.feishu\.cn/open-apis/bot/v2/hook/[a-f0-9-]{20,}|discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+|xox[abp]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|AKIA[0-9A-Z]{16}"
files=$(git ls-files --cached --others --exclude-standard | grep -v -E '^scripts/leak-check\.sh$|^node_modules/')
status=0
if [ -n "$files" ]; then
  # shellcheck disable=SC2086
  if printf '%s\n' $files | xargs grep -n -E "$pattern" -- 2>/dev/null; then status=1; fi
fi
stray=$(git ls-files --others --exclude-standard | grep -E '(^|/)(proxy\.env|auth\.json|models\.json|adonis-pi\.json|settings\.json|.*\.env(\..*)?)$' | grep -v '^templates/')
if [ -n "$stray" ]; then printf 'stray account-layer file: %s\n' $stray; status=2; fi
[ "$status" -eq 0 ] && echo "leak-check: clean"
exit "$status"
