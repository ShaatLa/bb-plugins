#!/bin/sh
# Run a foreground command under a renewable Machine Slots use.
interval=${SLOTS_RUN_TEST_STEP:-1}
dir=$(mktemp -d "${TMPDIR:-/tmp}/slots-run.XXXXXX") || exit 70
use= loop= cleaned=
cleanup() {
  [ -n "$cleaned" ] && return
  cleaned=1
  if [ -n "$loop" ]; then
    : > "$dir/stop"
    n=0
    while kill -0 "$loop" 2>/dev/null && [ "$n" -lt 5 ]; do sleep "$interval"; n=$((n + 1)); done
    if kill -0 "$loop" 2>/dev/null; then kill -KILL "$loop" 2>/dev/null; fi
    wait "$loop" 2>/dev/null
  fi
  if [ -n "$use" ]; then
    bb slots done "$use" >/dev/null 2>&1 & dp=$!
    n=0
    while kill -0 "$dp" 2>/dev/null && [ "$n" -lt 10 ]; do sleep "$interval"; n=$((n + 1)); done
    if kill -0 "$dp" 2>/dev/null; then kill -KILL "$dp" 2>/dev/null; fi
    wait "$dp" 2>/dev/null
  fi
  rm -rf "$dir"
}
# Runs on the other machine: refresh the worktree mirror, install dependencies when a lockfile changed, then the command.
RUNNER='
key=$1 rel=$2 hash=$3 upload=$4; shift 4
base=$HOME/.bb-slots/work m=$HOME/.bb-slots/work/$key
mkdir -p "$m" || exit 69
n=0
while ! mkdir "$m.lock" 2>/dev/null; do
  n=$((n + 1)); [ "$n" -lt 600 ] || { echo "slots-run: mirror $m is locked; remove $m.lock if no run is active" >&2; rm -f "$upload"; exit 69; }
  sleep 1
done
fail() { rmdir "$m.lock" 2>/dev/null; rm -f "$upload" "$m.tgz"; echo "slots-run: $1" >&2; exit 69; }
trap "fail \"stopped while preparing the mirror\"" HUP INT TERM
# An unchanged worktree never rewrites files under a run that is still using them.
if [ "$(cat "$m.hash" 2>/dev/null)" != "$hash" ]; then
  base64 -d <"$upload" >"$m.tgz" && tar tzf "$m.tgz" | sort >"$m.new" && tar xzf "$m.tgz" -C "$m" || fail "could not unpack the worktree"
  if [ -f "$m.manifest" ]; then comm -23 "$m.manifest" "$m.new" | while IFS= read -r f; do rm -f "$m/$f"; done; fi
  mv "$m.new" "$m.manifest"; rm -f "$m.tgz"
  d=$rel
  while :; do
    for f in package-lock.json bun.lock bun.lockb; do
      [ -f "$m/$d/$f" ] || continue
      sum=$(shasum "$m/$d/$f" | cut -c1-40)
      if [ "$(cat "$m/$d/node_modules/.bb-slots-lock" 2>/dev/null)" != "$sum" ]; then
        echo "slots-run: installing dependencies in $d" >&2
        case $f in
          package-lock.json) (cd "$m/$d" && npm ci --no-audit --no-fund </dev/null >&2) ;;
          *) (cd "$m/$d" && bun install --frozen-lockfile </dev/null >&2) ;;
        esac || fail "dependency install failed in $d"
        printf %s "$sum" >"$m/$d/node_modules/.bb-slots-lock"
      fi
      break
    done
    [ "$d" = . ] && break
    d=$(dirname "$d")
  done
  printf %s "$hash" >"$m.hash"
fi
trap - HUP INT TERM
rmdir "$m.lock"; rm -f "$upload"; touch "$m"
find "$base" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null
cd "$m/$rel" || exit 69
exec "$@" </dev/null
'
# Copy the worktree (tracked and untracked files, not ignored ones) to the leased machine and run the command there.
remote_run() {
  root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "slots-run: the lease is on $host, but this directory is not in a git worktree" >&2; return 69; }
  here=$(pwd -P)
  case $here in "$root") rel=. ;; "$root"/*) rel=${here#"$root"/} ;; *) rel=. ;; esac
  key=$(printf %s "$root" | shasum | cut -c1-16)
  term=term_$(LC_ALL=C tr -dc 23456789abcdefghijkmnpqrstuvwxyz </dev/urandom | head -c 10)
  # Deleted tracked files are left out; the mirror drops them through its manifest.
  (cd "$root" && git ls-files -z -co --exclude-standard | tr '\0' '\n' | while IFS= read -r f; do { [ -e "$f" ] || [ -h "$f" ]; } && printf '%s\n' "$f"; done) >"$dir/files" || return 69
  hash=$(tar cf - -C "$root" -T "$dir/files" | shasum | cut -c1-40)
  upload=${SLOTS_RUN_UPLOAD_DIR:-/tmp}/bb-slots-$term.b64
  if ! tar czf - -C "$root" -T "$dir/files" | base64 | bb file write --host "$host" --stdin "$upload" >/dev/null 2>"$dir/err"; then
    echo "slots-run: could not copy the worktree to $host: $(tail -n 1 "$dir/err")" >&2; return 69
  fi
  echo "slots-run: running on $host" >&2
  bb terminal run --machine "$host" --id "$term" --timeout 12h --max-output-bytes 1048576 -- sh -c "$RUNNER" sh "$key" "$rel" "$hash" "$upload" "$@" >"$dir/out" 2>&1
  code=$?
  if [ -n "$interrupted" ]; then bb terminal close "$term" >/dev/null 2>&1; grep -v "^Terminal $term " "$dir/out"; return 130; fi
  if [ "$code" -eq 0 ]; then cat "$dir/out"; return 0; fi
  if grep -qx "Terminal $term exited with code $code\." "$dir/out"; then grep -vx "Terminal $term exited with code $code\." "$dir/out"; return "$code"; fi
  grep -v "^Terminal $term " "$dir/out"
  bb terminal close "$term" >/dev/null 2>&1
  if [ "$code" -eq 124 ] && grep -q "^Terminal $term is still running" "$dir/out"; then echo "slots-run: the run on $host timed out after 12h and was stopped" >&2; return 124; fi
  echo "slots-run: the run on $host failed to start or lost its machine (bb exit $code)" >&2
  return 69
}
trap 'cleanup' EXIT
trap 'interrupted=1' INT TERM HUP
pool=heavy job= est= priority= timeout= spill= host= interrupted=
while [ "$#" -gt 0 ]; do
  case $1 in
    --) shift; break ;;
    --spill) spill=1; shift ;;
    --pool|--job|--est|--priority|--timeout)
      option=$1; shift; [ "$#" -gt 0 ] || exit 64
      case $option in
        --pool) pool=$1 ;; --job) job=$1 ;; --est) est=$1 ;;
        --priority) priority=$1 ;; --timeout) timeout=$1 ;;
      esac
      shift ;;
    *) exit 64 ;;
  esac
done
[ "$#" -gt 0 ] && [ -n "$job" ] && [ -n "$est" ] || exit 64
line=$(
  set -- --pool "$pool" --job "$job" --est "$est"
  [ -z "$priority" ] || set -- "$@" --priority "$priority"
  # The command runs here, so a local-model use pins this Mac rather than taking another device.
  [ "$pool" != local-model ] || set -- "$@" --device local
  [ -z "$timeout" ] || set -- "$@" --timeout "$timeout"
  [ -z "$spill" ] || set -- "$@" --spill
  bb slots acquire "$@"
)
status=$?
[ "$status" -eq 0 ] || exit "$status"
case $line in *'
'*) exit 70 ;; esac
read -r label use label2 lease label3 renew label4 host extra <<EOF_LINE
$line
EOF_LINE
case $use in use-*) digits=${use#use-} ;; *) exit 70 ;; esac
case $digits in ''|*[!0-9]*) use=; exit 70 ;; esac
case $lease in lease-*) digits=${lease#lease-} ;; *) use=; exit 70 ;; esac
case $digits in ''|*[!0-9]*) use=; exit 70 ;; esac
case $renew in ''|*[!0-9]*|0) use=; exit 70 ;; esac
[ "$renew" -gt 0 ] 2>/dev/null || { use=; exit 70; }
[ "$label" = use ] && [ "$label2" = lease ] && [ "$label3" = renew ] && [ -z "$extra" ] || { use=; exit 70; }
# `host <id>` appears only for a spilled lease on another machine.
{ [ -z "$label4" ] && [ -z "$host" ]; } || { [ "$label4" = host ] && [ -n "$spill" ] && [ -n "$host" ]; } || { use=; exit 70; }
start=$(ps -o lstart= -p "$$" 2>/dev/null) || start=
(
  trap '' INT TERM HUP
  while :; do
    n=0
    while [ "$n" -lt "$renew" ]; do
      [ ! -e "$dir/stop" ] && kill -0 "$$" 2>/dev/null || exit
      sleep "$interval"; n=$((n + 1))
    done
    [ ! -e "$dir/stop" ] && kill -0 "$$" 2>/dev/null || exit
    if [ -n "$start" ]; then
      current=$(ps -o lstart= -p "$$" 2>/dev/null) || exit
      [ -n "$current" ] && [ "$current" = "$start" ] || exit
    fi
    bb slots heartbeat --use "$use" >/dev/null 2>&1 & hp=$!
    n=0
    while kill -0 "$hp" 2>/dev/null && [ "$n" -lt 20 ]; do
      if [ -e "$dir/stop" ]; then kill -KILL "$hp" 2>/dev/null; wait "$hp" 2>/dev/null; exit; fi
      sleep "$interval"; n=$((n + 1))
    done
    if kill -0 "$hp" 2>/dev/null; then kill -KILL "$hp" 2>/dev/null; fi
    wait "$hp" 2>/dev/null; result=$?
    [ "$result" -ne 2 ] || exit
  done
) & loop=$!
if [ -n "$host" ]; then remote_run "$@"; else "$@"; fi
status=$?
exit "$status"
