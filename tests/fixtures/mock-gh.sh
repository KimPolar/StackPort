#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == release ]] || exit 1
action=$2
shift 3 # release, operation, tag

case "$action" in
  view)
    [[ -f "$MOCK_RELEASE_DIR/body" ]] || exit 1
    case " $* " in
      *" --json body "*) cat "$MOCK_RELEASE_DIR/body" ;;
      *" --json isDraft "*)
        if [[ " $* " == *" --jq "* ]]; then cat "$MOCK_RELEASE_DIR/draft"; else echo '{}'; fi ;;
      *" --json assets "*)
        for file in "$MOCK_RELEASE_DIR/assets/"*; do [[ ! -f "$file" ]] || basename "$file"; done ;;
      *) exit 1 ;;
    esac
    ;;
  create)
    if [[ "${MOCK_FAIL_GENERATED_NOTES:-}" == 1 && " $* " == *" --generate-notes "* ]]; then
      echo 'HTTP 500 generating release notes' >&2
      exit 1
    fi
    mkdir -p "$MOCK_RELEASE_DIR/assets"
    printf '<!-- stackport-actions-run:%s -->\n' "$GITHUB_RUN_ID" > "$MOCK_RELEASE_DIR/body"
    echo true > "$MOCK_RELEASE_DIR/draft"
    ;;
  upload)
    file=$1
    if [[ "${MOCK_FAIL_UPLOAD:-}" == "$(basename "$file")" ]]; then exit 1; fi
    cp "$file" "$MOCK_RELEASE_DIR/assets/$(basename "$file")"
    ;;
  download)
    [[ "$1" == --pattern && "$3" == --dir ]] || exit 1
    cp "$MOCK_RELEASE_DIR/assets/$2" "$4/$2"
    ;;
  edit)
    echo false > "$MOCK_RELEASE_DIR/draft"
    ;;
  *) exit 1 ;;
esac
