#!/usr/bin/env bash
set -euo pipefail

if [[ ! "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ||
      ! "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ || ! "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]; then
  echo 'Invalid release tag, commit or workflow run ID.' >&2
  exit 1
fi

(cd release-assets && sha256sum --check SHA256SUMS.txt)
git fetch --tags origin
if git show-ref --verify --quiet "refs/tags/$RELEASE_TAG"; then
  tag_type=$(git cat-file -t "refs/tags/$RELEASE_TAG")
  tag_commit=$(git rev-parse "refs/tags/$RELEASE_TAG^{}")
  tag_subject=$(git for-each-ref --format='%(contents:subject)' "refs/tags/$RELEASE_TAG")
  if [[ "$tag_type" != tag || "$tag_commit" != "$GITHUB_SHA" || "$tag_subject" != "StackPort Actions run $GITHUB_RUN_ID" ]]; then
    echo 'The release tag already belongs to a different run or commit.' >&2
    exit 1
  fi
else
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  git tag -a "$RELEASE_TAG" "$GITHUB_SHA" -m "StackPort Actions run $GITHUB_RUN_ID"
  git push origin "refs/tags/$RELEASE_TAG"
fi

marker="<!-- stackport-actions-run:$GITHUB_RUN_ID -->"
if ! gh release view "$RELEASE_TAG" --json isDraft > /dev/null 2>&1; then
  draft_options=(
    --draft --verify-tag --title "StackPort $RELEASE_TAG"
    --notes "Windows x64 실행 파일입니다. WebView2 Runtime이 필요하며 코드 서명되지 않았습니다. $marker"
  )
  if ! gh release create "$RELEASE_TAG" "${draft_options[@]}" --generate-notes; then
    if ! gh release view "$RELEASE_TAG" --json isDraft > /dev/null 2>&1; then
      echo 'Retrying draft creation with the bundled release notes.'
      gh release create "$RELEASE_TAG" "${draft_options[@]}"
    fi
  fi
fi
body=$(gh release view "$RELEASE_TAG" --json body --jq .body)
if [[ "$body" != *"$marker"* ]]; then
  echo 'The existing release was not created by this workflow run.' >&2
  exit 1
fi
if [[ $(gh release view "$RELEASE_TAG" --json isDraft --jq .isDraft) == false ]]; then
  for file in StackPort-Windows-x64.exe SHA256SUMS.txt; do
    gh release view "$RELEASE_TAG" --json assets --jq '.assets[].name' | grep -Fx "$file" > /dev/null
  done
  echo 'This run already published its release; existing assets were preserved.'
  exit 0
fi

mkdir -p "$RUNNER_TEMP/stackport-existing-assets"
for file in StackPort-Windows-x64.exe SHA256SUMS.txt; do
  if gh release view "$RELEASE_TAG" --json assets --jq '.assets[].name' | grep -Fx "$file" > /dev/null; then
    gh release download "$RELEASE_TAG" --pattern "$file" --dir "$RUNNER_TEMP/stackport-existing-assets"
    cmp "release-assets/$file" "$RUNNER_TEMP/stackport-existing-assets/$file"
  else
    gh release upload "$RELEASE_TAG" "release-assets/$file"
  fi
done
gh release edit "$RELEASE_TAG" --draft=false
