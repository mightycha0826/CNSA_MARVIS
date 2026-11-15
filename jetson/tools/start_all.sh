#!/usr/bin/env bash
# One click start: everything the demo needs after the Jetson was switched on.
#   tools/start_all.sh                     # hotspot, web app, certificate, hub, monitor page, headset
#   tools/start_all.sh --dev               # the hub also takes dev.* messages (tools/fake_quest.py)
#   tools/start_all.sh --status            # say what is running; changes nothing
#   tools/start_all.sh --stop              # stop the hub this script starts; nothing else
#   tools/start_all.sh --install-shortcut  # the "Start MARVIS" icon: on the desktop and in the app list
# More options: --no-browser (do not open the monitor page), --no-wait (do not wait for the headset),
#   --pause (keep the window open until Enter; the icon passes it), --help.
# Safe to run again at any time: the hub is stopped and started again, the rest is left as it is.
# Environment: MARSWALK_PORT (8443) and MARSWALK_HTTP_PORT (8080); MARSWALK_HUB_ARGS (more options for
#   the hub, split at spaces); MARSWALK_LOG_DIR (logs/, holds hub.log and hub.pid);
#   MARSWALK_DESKTOP_DIR and MARSWALK_APPS_DIR (where --install-shortcut writes).
# Nothing here uses sudo. Where something needs it, the line says what to type.
set -u   # no "set -e": a step that fails says why, and the window stays readable

TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
JETSON=$(dirname "$TOOLS")
REPO=$(dirname "$JETSON")

PORT=${MARSWALK_PORT:-8443}
HTTP_PORT=${MARSWALK_HTTP_PORT:-8080}
LOG_DIR=${MARSWALK_LOG_DIR:-$JETSON/logs}
LOG=$LOG_DIR/hub.log
PIDFILE=$LOG_DIR/hub.pid
HOTSPOT=${MARSWALK_HOTSPOT:-marswalk}          # the NetworkManager connection made by setup_hotspot.sh
UNIT=${MARSWALK_UNIT:-marswalk-hub}            # the systemd service, where it is installed
START_WAIT_S=${MARSWALK_START_WAIT_S:-90}      # the speech models take a while to load
WATCH_S=${MARSWALK_WATCH_S:-600}               # how long to wait for the headset
HEADSET_URL=https://10.42.0.1:$PORT/           # the hotspot address, as in the certificate
MONITOR_URL=http://localhost:$HTTP_PORT/monitor
LAUNCHER="Start MARVIS.desktop"
read -r -a HUB_ARGS <<< "${MARSWALK_HUB_ARGS:-}"

PYBIN=$JETSON/.venv/bin/python
[ -x "$PYBIN" ] || PYBIN=python3

MODE=start
BROWSER=1
WAIT=1
PAUSE=0
WATCHING=0        # 1 while waiting for the headset: Ctrl+C then only ends the waiting
STOP_WATCH=0
HUB_PID=""
HUB_BY_UNIT=0
LOG_FROM=0
S_HOTSPOT="not checked"
S_HEADSET="not connected"
M_SOURCES=0
M_VIEWERS=0
M_AR=0

line() { printf '%-12s %-5s %s\n' "$1" "$2" "$3"; }
row() { printf '%-12s %s\n' "$1" "$2"; }

usage() { awk 'NR > 1 { if (/^#/) { sub(/^# ?/, ""); print } else exit }' "${BASH_SOURCE[0]}"; }

# Started from the icon, the window would close with the script: wait for Enter first, also
# after an error, so the reason can be read.
finish() {
  local code=$?
  trap - EXIT
  if [ "$PAUSE" = 1 ] && [ -t 0 ]; then
    echo
    read -r -p "Press Enter to close this window. " _
  fi
  exit "$code"
}

on_int() {
  if [ "$WATCHING" = 1 ]; then
    STOP_WATCH=1
    return
  fi
  echo
  echo "Interrupted. If the hub was started already it keeps running. To stop it: $(stop_hint)"
  PAUSE=0
  exit 130
}

stop_hint() {
  local env=""
  [ "$PORT" = 8443 ] || env="MARSWALK_PORT=$PORT "
  [ "$HTTP_PORT" = 8080 ] || env="${env}MARSWALK_HTTP_PORT=$HTTP_PORT "
  echo "${env}$TOOLS/start_all.sh --stop"
}

# ---------- which process is the hub ----------

# Still running? One that has ended but was not collected by its parent yet does not count.
running() { [ -r "/proc/$1/status" ] && ! grep -q '^State:.*zombie' "/proc/$1/status" 2>/dev/null; }

any_running() {
  local pid
  for pid in "$@"; do running "$pid" && return 0; done
  return 1
}

# A hub of this user: "marswalk.hub" is one whole word of its command line. Asked again before
# every signal, because a pid can be handed to another program.
is_hub() {
  running "$1" || return 1
  [ "$(stat -c %u "/proc/$1" 2>/dev/null)" = "$(id -u)" ] || return 1
  tr '\0' '\n' < "/proc/$1/cmdline" 2>/dev/null | grep -qxF marswalk.hub
}

# The pids listening on a TCP port, one per line. ss only names the programs of this user.
port_pids() { ss -Hltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -un; }

port_busy() { [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]; }

# A port stays listed for a moment after its program has gone: up to 2 s for it to be free.
port_freed() {
  local i
  for ((i = 0; i < 10; i++)); do
    port_busy "$1" || return 0
    sleep 0.2
  done
  return 1
}

port_owner() {
  local who
  who=$(ss -Hltnp "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)",pid=\([0-9]*\).*/\1, pid \2/p' | head -n 1)
  echo "${who:-a program of another user}"
}

# The hubs this script is about: the ones that listen on its two ports, and the one it started
# last if that is still loading its models (no port open yet; hub.pid and its --port say so).
hub_pids() {
  local pid
  {
    for pid in $(port_pids "$PORT") $(port_pids "$HTTP_PORT"); do
      is_hub "$pid" && echo "$pid"
    done
    pid=$(cat "$PIDFILE" 2>/dev/null)
    case $pid in
      '' | *[!0-9]*) ;;
      *) is_hub "$pid" && tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null |
           grep -x -A1 -e --port | grep -qx -e "$PORT" && echo "$pid" ;;
    esac
  } | sort -un
}

# TERM, up to 5 s to end, then KILL.
stop_hubs() {
  local pid i
  for pid in "$@"; do is_hub "$pid" && kill -TERM "$pid" 2>/dev/null; done
  for ((i = 0; i < 25; i++)); do
    any_running "$@" || return 0
    sleep 0.2
  done
  for pid in "$@"; do is_hub "$pid" && kill -KILL "$pid" 2>/dev/null; done
  for ((i = 0; i < 10; i++)); do
    any_running "$@" || return 0
    sleep 0.2
  done
  return 1
}

unit_active() { command -v systemctl > /dev/null && systemctl is-active --quiet "$UNIT" 2> /dev/null; }

# ---------- what the hub says ----------

# One look at /monitor.json: M_SOURCES (headset pages connected), M_VIEWERS (monitor pages open),
# M_AR (1 when a picture taken in AR arrived in the last 3 s; the hub keeps the last "ar" it was
# told, so that alone could be hours old). Fails when the hub does not answer.
mon() {
  local out
  out=$("$PYBIN" -c '
import json, sys, urllib.request
try:
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    d = json.load(direct.open(sys.argv[1], timeout=2))
except Exception:
    sys.exit(1)
age = d.get("ageS")
live = d.get("sources", 0) > 0 and age is not None and age < 3
ar = live and (d.get("info") or {}).get("ar") is True
print(int(d.get("sources", 0)), int(d.get("viewers", 0)), 1 if ar else 0)
' "http://127.0.0.1:$HTTP_PORT/monitor.json" 2> /dev/null) || return 1
  read -r M_SOURCES M_VIEWERS M_AR <<< "$out"
}

# The headset in words, after a mon that answered. The app only sends pictures (and with them
# whether it is in AR) while a monitor page is open.
headset_words() {
  if [ "$M_AR" = 1 ]; then
    echo "in AR"
  elif [ "$M_SOURCES" -gt 0 ] && [ "$M_VIEWERS" -gt 0 ]; then
    echo "page connected, not in AR: press Field map or Mars map in the headset"
  elif [ "$M_SOURCES" -gt 0 ]; then
    echo "page connected (whether it is in AR shows only while a monitor page is open)"
  else
    echo "not connected: open $HEADSET_URL in its browser, then press Field map or Mars map"
  fi
}

# A desktop notification as well, when there is a desktop to show it on.
notify() {
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || return 0
  command -v notify-send > /dev/null || return 0
  timeout 3 notify-send -a MARVIS -i applications-science "MARVIS" "$1" > /dev/null 2>&1
  return 0
}

# Wait a moment. Says yes when Enter was pressed meanwhile.
nap() {
  if [ -t 0 ]; then
    read -r -t "$1" _
    [ $? -le 128 ]   # a line or the end of the input; above 128 the time ran out
  else
    sleep "$1"
    return 1
  fi
}

# ---------- the steps ----------

hotspot_state() {
  nmcli -t -f NAME,STATE con show --active 2> /dev/null | awk -F: -v n="$HOTSPOT" '$1 == n { print $2; exit }'
}

hotspot_ip() { nmcli -g IP4.ADDRESS con show "$HOTSPOT" 2> /dev/null | head -n 1 | cut -d/ -f1 | tr -d ' '; }

step_hotspot() {
  local state err i
  if ! command -v nmcli > /dev/null; then
    line Hotspot NOTE "nmcli is not installed here, so the hotspot was not looked at."
    return
  fi
  state=$(hotspot_state)
  if [ "$state" != activated ]; then
    if ! nmcli -t -f NAME con show 2> /dev/null | grep -qxF -e "$HOTSPOT"; then
      S_HOTSPOT="not set up"
      line Hotspot FAIL "there is no connection \"$HOTSPOT\". Make it once: sudo $TOOLS/setup_hotspot.sh '<password>'"
      return
    fi
    # Just after a boot it may be on its way up already: give it a moment before asking again.
    for ((i = 0; i < 20; i++)); do
      [ "$state" = activating ] || break
      sleep 1
      state=$(hotspot_state)
    done
    if [ "$state" != activated ] && ! err=$(nmcli -w 30 con up "$HOTSPOT" 2>&1); then
      S_HOTSPOT="down"
      line Hotspot FAIL "\"$HOTSPOT\" did not come up (${err##*$'\n'}). Try: sudo nmcli con up $HOTSPOT"
      return
    fi
  fi
  S_HOTSPOT="up, $(hotspot_ip)"
  line Hotspot OK "\"$HOTSPOT\" is up ($(hotspot_ip))"
}

# Only a missing build is made. One that is there is never built again from here.
step_web() {
  if [ -f "$REPO/web/dist/index.html" ]; then
    line "Web app" OK "web/dist is built (left as it is)"
    return
  fi
  line "Web app" NOTE "web/dist/index.html is missing: building it with tools/build_web.sh"
  "$TOOLS/build_web.sh"
  if [ -f "$REPO/web/dist/index.html" ]; then
    line "Web app" OK "built"
  else
    line "Web app" FAIL "the build did not make web/dist/index.html (see above). The hub serves its connection test page until tools/build_web.sh works."
  fi
}

step_cert() {
  local cert=$JETSON/certs/cert.pem key=$JETSON/certs/key.pem out
  if [ ! -f "$cert" ] || [ ! -f "$key" ]; then
    out=$("$TOOLS/make_cert.sh" 2>&1)
    if [ -f "$cert" ] && [ -f "$key" ]; then
      line Certificate OK "made a new one. The headset asks once to accept it (Advanced, Proceed)."
    else
      line Certificate FAIL "tools/make_cert.sh did not make certs/cert.pem (${out##*$'\n'}). Without it the headset gets no AR and no microphone."
    fi
  elif command -v openssl > /dev/null && ! openssl x509 -in "$cert" -noout -checkend 0 > /dev/null 2>&1; then
    line Certificate NOTE "certs/cert.pem has run out, the headset will warn again. tools/make_cert.sh makes a new one."
  else
    line Certificate OK "certs/cert.pem"
  fi
}

step_hub() {
  local p
  local -a pids
  if unit_active; then
    HUB_BY_UNIT=1
    line Hub NOTE "the systemd service $UNIT runs the hub: left to it (to restart: sudo systemctl restart $UNIT)"
    return 0
  fi
  if [ ! -x "$JETSON/.venv/bin/python" ]; then
    line Hub FAIL "jetson/.venv is missing. Do the one-time setup in jetson/README.md first."
    return 1
  fi
  mapfile -t pids < <(hub_pids)
  if [ "${#pids[@]}" -gt 0 ]; then
    if ! stop_hubs "${pids[@]}"; then
      line Hub FAIL "the running hub (pid ${pids[*]}) did not stop."
      return 1
    fi
    line Hub OK "stopped the running one (pid ${pids[*]})"
  fi
  for p in "$PORT" "$HTTP_PORT"; do
    if ! port_freed "$p"; then
      line Hub FAIL "port $p is taken by $(port_owner "$p"), which is not a hub of yours. Stop it, or use other ports (MARSWALK_PORT, MARSWALK_HTTP_PORT)."
      return 1
    fi
  done
  if ! mkdir -p "$LOG_DIR" || ! printf '\n==== %s  start_all.sh starts the hub (ports %s and %s) ====\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$PORT" "$HTTP_PORT" >> "$LOG"; then
    line Hub FAIL "cannot write $LOG"
    return 1
  fi
  LOG_FROM=$(stat -c %s "$LOG" 2> /dev/null || echo 0)
  # In a session of its own, so closing this window does not stop it.
  (cd "$JETSON" && exec setsid nohup .venv/bin/python -m marswalk.hub --port "$PORT" --http-port "$HTTP_PORT" \
    "${HUB_ARGS[@]}" >> "$LOG" 2>&1 < /dev/null) &
  HUB_PID=$!
  echo "$HUB_PID" > "$PIDFILE"
  return 0
}

# The last 25 lines this start wrote to the log (not what an earlier hub left there).
log_tail() { tail -c "+$((LOG_FROM + 1))" "$LOG" 2> /dev/null | tail -n 25 | sed 's/^/    /'; }

step_wait() {
  local i how
  printf 'Waiting for the hub to answer (the speech models take a while) '
  for ((i = 1; i <= START_WAIT_S; i++)); do
    if mon; then
      echo
      if [ "$HUB_BY_UNIT" = 1 ]; then
        line Hub OK "answers on port $HTTP_PORT"
      else
        how=$(tail -c "+$((LOG_FROM + 1))" "$LOG" 2> /dev/null | grep -m 1 -o 'stt=[^ ]* tts=[^ ]* serial=[^ ]* dev=[^ ]*')
        line Hub OK "running, pid $HUB_PID${how:+ ($how)}, log $LOG"
      fi
      return 0
    fi
    if [ -n "$HUB_PID" ] && ! running "$HUB_PID"; then
      echo
      rm -f "$PIDFILE"
      line Hub FAIL "the hub stopped while it was starting. The end of $LOG:"
      log_tail
      return 1
    fi
    printf .
    sleep 1
  done
  echo
  if [ "$HUB_BY_UNIT" = 1 ]; then
    line Hub FAIL "no answer on port $HTTP_PORT after $START_WAIT_S s. Look at: journalctl -u $UNIT -n 50"
  else
    line Hub FAIL "no answer on port $HTTP_PORT after $START_WAIT_S s (pid $HUB_PID is still running). The end of $LOG:"
    log_tail
  fi
  return 1
}

step_monitor() {
  local i
  if [ "$BROWSER" = 0 ]; then
    line Monitor OK "$MONITOR_URL (not opened: --no-browser)"
    return
  fi
  # A monitor page that was left open finds the new hub by itself within a few seconds.
  for i in 1 2 3 4 5; do
    if mon && [ "$M_VIEWERS" -gt 0 ]; then
      line Monitor OK "$MONITOR_URL is open already"
      return
    fi
    sleep 1
  done
  if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || ! command -v xdg-open > /dev/null; then
    line Monitor NOTE "no desktop to open a browser on. Open $MONITOR_URL in a browser on this Jetson."
    return
  fi
  setsid nohup xdg-open "$MONITOR_URL" > /dev/null 2>&1 < /dev/null &
  line Monitor OK "opened $MONITOR_URL in the browser"
}

step_headset() {
  local devices="" serial="" out
  if command -v adb > /dev/null; then
    devices=$(timeout 8 adb devices 2> /dev/null)   # the time limit: adb sometimes hangs
    serial=$(awk 'NR > 1 && $2 == "device" { print $1; exit }' <<< "$devices")
  fi
  if [ -n "$serial" ]; then
    if out=$(timeout 10 adb -s "$serial" shell am start -a android.intent.action.VIEW -d "$HEADSET_URL" < /dev/null 2>&1) &&
      ! grep -q Error <<< "$out"; then
      line Headset OK "opened $HEADSET_URL in the headset's browser over adb. Put it on and press Field map or Mars map."
    else
      line Headset NOTE "adb could not open the page (${out##*$'\n'}). In the headset: open $HEADSET_URL (bookmark), press Field map or Mars map."
    fi
  elif grep -q unauthorized <<< "$devices"; then
    line Headset NOTE "the headset is on the cable but has not allowed USB debugging. Accept that inside it, or open $HEADSET_URL there (bookmark) and press Field map or Mars map."
  else
    line Headset NOTE "put on the headset, open $HEADSET_URL in its browser (bookmark), press Field map or Mars map."
  fi
  if [ "$WAIT" = 1 ]; then
    watch_headset
  elif mon; then
    S_HEADSET=$(headset_words)
  fi
}

# Up to ten minutes: say when the headset's page connects and when it is in AR. The headset not
# being there is never an error.
watch_headset() {
  local deadline=$((SECONDS + WATCH_S)) seen=0 told=0
  echo "Waiting for the headset, up to $(((WATCH_S + 59) / 60)) min. Enter or Ctrl+C ends the waiting; everything keeps running."
  if [ -t 0 ]; then   # an Enter typed earlier is not meant for this
    while read -r -t 0 _; do read -r -t 0.05 _ || break; done
  fi
  WATCHING=1
  while [ "$STOP_WATCH" = 0 ] && [ "$SECONDS" -lt "$deadline" ]; do
    if mon; then
      S_HEADSET=$(headset_words)
      if [ "$M_SOURCES" -gt 0 ] && [ "$seen" = 0 ]; then
        seen=1
        line Headset OK "the headset's page is connected"
        notify "The headset's page is connected."
      fi
      if [ "$M_AR" = 1 ]; then
        line Headset OK "the headset is in AR"
        notify "The headset is in AR."
        break
      fi
      if [ "$seen" = 1 ] && [ "$M_VIEWERS" = 0 ] && [ "$told" = 0 ]; then
        told=1
        line Headset NOTE "no monitor page is open, so the hub is not told when AR starts. Open $MONITOR_URL to see it."
      fi
    elif [ -n "$HUB_PID" ] && ! is_hub "$HUB_PID"; then
      S_HEADSET="unknown"
      line Hub NOTE "the hub started here is gone (stopped, or started again from another window)."
      break
    fi
    nap 2 && break
  done
  WATCHING=0
}

# The one thing that needs sudo: said once, never done from here.
speed_hint() {
  local mode id
  command -v nvpmodel > /dev/null || return 0
  mode=$(timeout 5 nvpmodel -q 2> /dev/null | sed -n 's/^NV Power Mode: *//p')
  case $mode in
    *MAXN*) row Speed "power mode $mode. For the fastest speech also: sudo jetson_clocks" ;;
    *)
      id=$(sed -n 's/^< POWER_MODEL ID=\([0-9]*\) NAME=MAXN.*/\1/p' /etc/nvpmodel.conf 2> /dev/null | tail -n 1)
      row Speed "power mode ${mode:-unknown}. For faster speech: sudo nvpmodel -m ${id:-<the MAXN mode in /etc/nvpmodel.conf>}, then sudo jetson_clocks"
      ;;
  esac
}

summary() {
  echo
  echo "MARVIS is running."
  row Hotspot "$S_HOTSPOT"
  if [ "$HUB_BY_UNIT" = 1 ]; then
    row Hub "systemd service $UNIT; log: journalctl -u $UNIT -f"
  else
    row Hub "pid $HUB_PID; log: $LOG"
  fi
  row Monitor "$MONITOR_URL"
  row Headset "$S_HEADSET"
  if [ "$HUB_BY_UNIT" = 1 ]; then
    row Stop "sudo systemctl stop $UNIT"
  else
    row Stop "$(stop_hint)"
  fi
  speed_hint
}

# ---------- the other modes ----------

do_stop() {
  local -a pids
  if unit_active; then
    line Hub NOTE "the systemd service $UNIT runs the hub. Stop it with: sudo systemctl stop $UNIT"
    return 1
  fi
  mapfile -t pids < <(hub_pids)
  if [ "${#pids[@]}" -eq 0 ]; then
    rm -f "$PIDFILE"
    line Hub OK "no hub is running on ports $PORT and $HTTP_PORT: nothing to stop"
    return 0
  fi
  if ! stop_hubs "${pids[@]}"; then
    line Hub FAIL "pid ${pids[*]} did not stop."
    return 1
  fi
  rm -f "$PIDFILE"
  port_freed "$PORT"
  port_freed "$HTTP_PORT"
  line Hub OK "stopped (pid ${pids[*]})"
}

do_status() {
  local state p
  local -a pids
  if ! command -v nmcli > /dev/null; then
    row Hotspot "unknown (no nmcli here)"
  elif state=$(hotspot_state) && [ "$state" = activated ]; then
    row Hotspot "up (\"$HOTSPOT\", $(hotspot_ip))"
  elif nmcli -t -f NAME con show 2> /dev/null | grep -qxF -e "$HOTSPOT"; then
    row Hotspot "down (\"$HOTSPOT\" is ${state:-not active})"
  else
    row Hotspot "not set up (no connection \"$HOTSPOT\")"
  fi
  if [ -f "$REPO/web/dist/index.html" ]; then
    row "Web app" "built ($(date -r "$REPO/web/dist/index.html" '+%Y-%m-%d %H:%M'))"
  else
    row "Web app" "not built"
  fi
  if [ -f "$JETSON/certs/cert.pem" ] && [ -f "$JETSON/certs/key.pem" ]; then
    row Certificate "there ($(openssl x509 -in "$JETSON/certs/cert.pem" -noout -enddate 2> /dev/null | sed 's/^notAfter=/until /'))"
  else
    row Certificate "missing"
  fi
  mapfile -t pids < <(hub_pids)
  if unit_active; then
    row Hub "run by the systemd service $UNIT"
  elif [ "${#pids[@]}" -gt 0 ]; then
    row Hub "running, pid ${pids[*]} (ports $PORT and $HTTP_PORT)"
  else
    row Hub "not running on ports $PORT and $HTTP_PORT"
    for p in "$PORT" "$HTTP_PORT"; do
      port_busy "$p" && row "" "port $p is taken by $(port_owner "$p")"
    done
  fi
  if mon; then
    row Monitor "$MONITOR_URL ($M_VIEWERS open)"
    row Headset "$(headset_words)"
    return 0
  fi
  row Monitor "no answer from http://127.0.0.1:$HTTP_PORT/monitor.json"
  return 1
}

# A path as one quoted word of a desktop file's Exec line: quoted as for a shell, then every
# backslash doubled once more, which is the file's own way of writing one.
exec_word() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//\`/\\\`}
  s=${s//\$/\\\$}
  s=${s//\\/\\\\}
  printf '"%s"' "$s"
}

# The launcher of the project folder finds the script next to itself. A copy somewhere else
# cannot, so the copies name the script by its full path.
write_launcher() {
  local l
  {
    echo "# Written by $TOOLS/start_all.sh --install-shortcut"
    while IFS= read -r l; do
      case $l in
        '#'*) ;;
        Exec=*) printf 'Exec=%s --pause\n' "$(exec_word "$TOOLS/start_all.sh")" ;;
        *) printf '%s\n' "$l" ;;
      esac
    done < "$REPO/$LAUNCHER"
  } > "$1" && chmod 755 "$1"
}

do_install() {
  local desk apps f rc=0
  if [ ! -f "$REPO/$LAUNCHER" ]; then
    line Shortcut FAIL "$REPO/$LAUNCHER is missing."
    return 1
  fi
  case $TOOLS in
    *%*)   # the desktop reads % as the start of one of its own codes, and refuses %% in a program's path
      line Shortcut FAIL "the project folder has a % in its path ($REPO), which a launcher cannot name. Rename the folder first."
      return 1
      ;;
  esac
  desk=${MARSWALK_DESKTOP_DIR:-$(xdg-user-dir DESKTOP 2> /dev/null)}
  desk=${desk:-$HOME/Desktop}
  apps=${MARSWALK_APPS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/applications}

  f=$desk/$LAUNCHER
  if mkdir -p "$desk" && write_launcher "$f"; then
    # The desktop only runs a launcher that is marked as trusted ("Allow Launching").
    if command -v gio > /dev/null && gio set "$f" metadata::trusted true 2> /dev/null; then
      touch "$f"   # so the desktop looks at it again
      line Shortcut OK "$f: double-click it on the desktop"
    else
      line Shortcut NOTE "$f is written but could not be marked as trusted: right-click it on the desktop, Allow Launching."
    fi
  else
    line Shortcut FAIL "cannot write $f"
    rc=1
  fi

  f=$apps/marswalk-start.desktop
  if mkdir -p "$apps" && write_launcher "$f"; then
    line Shortcut OK "$f: \"Start MARVIS\" in the app list"
  else
    line Shortcut FAIL "cannot write $f"
    rc=1
  fi
  return "$rc"
}

main() {
  local a
  for a in "$@"; do
    case $a in
      --dev) HUB_ARGS+=(--dev) ;;
      --no-browser) BROWSER=0 ;;
      --no-wait) WAIT=0 ;;
      --pause) PAUSE=1 ;;
      --stop) MODE=stop ;;
      --status) MODE=status ;;
      --install-shortcut) MODE=install ;;
      -h | --help) MODE=help ;;
      *)
        echo "unknown option: $a" >&2
        usage >&2
        exit 2
        ;;
    esac
  done
  trap finish EXIT
  trap on_int INT
  trap 'PAUSE=0; exit 129' HUP

  for a in "$PORT" "$HTTP_PORT" "$START_WAIT_S" "$WATCH_S"; do
    case $a in
      '' | *[!0-9]*)
        echo "MARSWALK_PORT, MARSWALK_HTTP_PORT and the waiting times must be whole numbers (got \"$a\")." >&2
        exit 2
        ;;
    esac
  done

  case $MODE in
    help) usage; exit 0 ;;
    status) do_status; exit $? ;;
    stop) do_stop; exit $? ;;
    install) do_install; exit $? ;;
  esac

  echo "Starting MARVIS (hub on ports $PORT and $HTTP_PORT)."
  step_hotspot
  step_web
  step_cert
  step_hub || exit 1
  step_wait || exit 1
  step_monitor
  step_headset
  summary
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
