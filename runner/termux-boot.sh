#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot entry, installed as ~/.termux/boot/start-selfgit-ci.
# Expects ~/selfgit-ci/runner.py and the runner token in ~/.config/selfgit-ci/token.
termux-wake-lock
log=$HOME/selfgit-ci.log
[ -f "$log" ] && tail -c 1000000 "$log" > "$log.old" && mv "$log.old" "$log"
SELFGIT_CI_TOKEN_FILE=$HOME/.config/selfgit-ci/token SELFGIT_CI_WORKDIR=$HOME/ci-work setsid nohup sh -c '
mkdir -p "$SELFGIT_CI_WORKDIR"
while true; do
  python "$HOME/selfgit-ci/runner.py"
  sleep 15
done' >> "$log" 2>&1 < /dev/null &
