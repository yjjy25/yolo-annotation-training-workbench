#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
platform="${1:-Ubuntu}"
shopt -s nullglob
checks=(*"$platform"*.parts.sha256)
((${#checks[@]})) || { echo 'No matching part checksum files.'; exit 1; }
for checksum in "${checks[@]}"; do
    name="${checksum%.parts.sha256}"
    [[ ! -e "$name" ]] || { echo "Already exists: $name"; exit 1; }
    sha256sum -c -- "$checksum"
    cat -- "$name".part[0-9][0-9][0-9] > "$name.partial"
    expected="$(awk -v name="$name" '{sub(/\r$/, "", $2); if ($2==name) print $1}' SHA256SUMS.txt)"
    [[ ${#expected} -eq 64 ]] || { echo 'Missing full checksum.'; exit 1; }
    echo "$expected  $name.partial" | sha256sum -c -
    mv -- "$name.partial" "$name"
    echo "Verified: $name"
done
