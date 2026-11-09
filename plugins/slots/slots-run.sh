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
trap 'cleanup' EXIT
trap ':' INT TERM HUP
pool=heavy job= est= priority= timeout=
while [ "$#" -gt 0 ]; do
  case $1 in
    --) shift; break ;;
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
  [ -z "$timeout" ] || set -- "$@" --timeout "$timeout"
  bb slots acquire "$@"
)
status=$?
[ "$status" -eq 0 ] || exit "$status"
case $line in *'
'*) exit 70 ;; esac
read -r label use label2 lease label3 renew extra <<EOF_LINE
$line
EOF_LINE
case $use in use-*) digits=${use#use-} ;; *) exit 70 ;; esac
case $digits in ''|*[!0-9]*) use=; exit 70 ;; esac
case $lease in lease-*) digits=${lease#lease-} ;; *) use=; exit 70 ;; esac
case $digits in ''|*[!0-9]*) use=; exit 70 ;; esac
case $renew in ''|*[!0-9]*|0) use=; exit 70 ;; esac
[ "$renew" -gt 0 ] 2>/dev/null || { use=; exit 70; }
[ "$label" = use ] && [ "$label2" = lease ] && [ "$label3" = renew ] && [ -z "$extra" ] || { use=; exit 70; }
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
"$@"
status=$?
exit "$status"
