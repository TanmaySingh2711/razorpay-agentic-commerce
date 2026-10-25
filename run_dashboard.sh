#!/usr/bin/env bash
#
# Starts the app on macOS and Linux and opens it in your browser.
#
#   ./run_dashboard.sh        (or: bash run_dashboard.sh)
#   PORT=3001 ./run_dashboard.sh   when another app already uses port 3000
#
# The same as run_dashboard.bat on Windows: the app and the database check
# start side by side, the browser opens at http://localhost:3000 as soon as the
# first page is ready, and the other pages are compiled in the background so
# the first click on each is quick. One press of Esc stops the app; Ctrl+C
# does not, so it cannot leave the app half-stopped. Run ./setup.sh once first.
#
# Written for the bash 3.2 that macOS still ships: no fractional `read -t`, no
# associative arrays.

set -uo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
# Compiled in the background once the browser is open. The purchase address
# names a purchase that does not exist: the answer is "not found", but the page
# a real purchase opens is compiled by then all the same.
WARM_PAGES="/shop /how-it-works /history /merchant /shop/00000000-0000-4000-8000-000000000000"
GIVE_UP_SECONDS=600

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed. Run ./setup.sh first - it tells you what to install." >&2
  exit 1
fi

if [ ! -f node_modules/next/package.json ]; then
  echo "The project is not set up yet. Run ./setup.sh first, then run this again." >&2
  exit 1
fi

# --- Helpers -----------------------------------------------------------------

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null
}

serving() {
  # True once the app answers with a real page. The request also makes the
  # dev server compile the page, so the browser opens onto a finished page.
  # (Opening it as soon as the port opened was measured to be slower: the
  # browser's own requests competed with this compile.)
  port_in_use && curl --silent --fail --output /dev/null --max-time 90 "${URL}/"
}

open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "$1" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 &
  else
    echo "  Open $1 in your browser."
  fi
}

# Next.js starts worker processes of its own: stop the whole tree, or the port
# stays taken by an orphan the next run would trip over.
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$1" 2>/dev/null || true
}

# Esc is read without waiting for Enter, and is the one way to stop. Ctrl+C is
# read as an ordinary key (-isig), so it cannot stop the app or the node
# processes sharing this terminal. The terminal is put back exactly as it was
# on every way out.
interactive=false
saved_tty=""
if [ -t 0 ]; then
  interactive=true
  saved_tty="$(stty -g)"
  # No echo, no line buffering, no Ctrl+C signal, and a read gives up after a
  # tenth of a second.
  stty -echo -icanon -isig min 0 time 1
fi

escape_pressed() {
  local key="" rest=""
  if [ "$interactive" != true ]; then
    sleep 0.1
    return 1
  fi
  IFS= read -r -n 1 key || true
  if [ "$key" = $'\003' ]; then
    echo "  Press Esc to stop the app."
    return 1
  fi
  [ "$key" = $'\e' ] || return 1
  # Arrow and function keys also begin with Esc, followed at once by more
  # characters. Only an Esc on its own stops the app.
  IFS= read -r -n 1 rest || true
  if [ -n "$rest" ]; then
    while IFS= read -r -n 1 rest && [ -n "$rest" ]; do :; done
    return 1
  fi
  return 0
}

server=""
database=""
cleanup() {
  [ -n "$server" ] && kill_tree "$server"
  [ -n "$database" ] && kill_tree "$database"
  [ -n "$saved_tty" ] && stty "$saved_tty"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

# --- Run ---------------------------------------------------------------------

if port_in_use; then
  echo
  echo "Something is already running on port ${PORT}."
  echo "If it is this app from an earlier run, stop that one first. If it is"
  echo "another app, start this one on a free port: PORT=3001 ./run_dashboard.sh"
  echo "Opening ${URL} anyway."
  open_browser "$URL"
  if [ "$interactive" = true ]; then
    echo "Press Esc to close this."
    until escape_pressed; do :; done
  fi
  exit 0
fi

echo
echo "  Razorpay Agentic Commerce"
echo "  Starting the app at ${URL} and checking the database alongside it."
echo "  The browser opens by itself as soon as the first page is ready."
echo "  Press Esc to stop the app."
echo

# Side by side rather than one after the other (which is what `npm run dev`
# does through `predev`): the overview needs no database, so the browser can
# open while the database check - or Docker starting - is still running. Both
# are called through node directly; going through npm costs a second for
# nothing.
node node_modules/tsx/dist/cli.mjs scripts/start-database.ts &
database=$!
node node_modules/next/dist/bin/next dev --port "$PORT" &
server=$!

opened=false
started=$SECONDS
while kill -0 "$server" 2>/dev/null; do
  if escape_pressed; then
    exit 0
  fi

  if [ "$opened" = false ]; then
    if serving; then
      open_browser "$URL"
      opened=true
      echo
      echo "  Opened ${URL}  (Esc stops the app)"
      echo
      for page in $WARM_PAGES; do
        if escape_pressed; then exit 0; fi
        curl --silent --output /dev/null --max-time 90 "${URL}${page}" || true
      done
    elif [ $((SECONDS - started)) -gt "$GIVE_UP_SECONDS" ]; then
      # Generous on purpose: the first step starts Docker and lets PostgreSQL
      # recover if it was shut down uncleanly.
      echo "  The app has not started after 10 minutes. Check the messages above."
      opened=true
    fi
  fi
done

# The server stopped on its own, which means something went wrong. Its last
# messages are above.
echo
echo "The app stopped. Read the messages above." >&2
exit 1
