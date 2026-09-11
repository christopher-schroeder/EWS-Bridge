#!/usr/bin/env bash
# End-to-end test: real Thunderbird (headless, throwaway profile) + this
# add-on + a seeded mock Exchange server. Leaves your own profiles untouched.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$ROOT/.e2e"
PORT="${E2E_PORT:-18443}"
TIMEOUT="${E2E_TIMEOUT:-300}"
ID="ews-bridge@schroeder.tu-dortmund.de"

rm -rf "$WORK"
mkdir -p "$WORK/profile/extensions" "$WORK/ext"

# Test copy of the extension with the scenario injected.
cp -r "$ROOT/manifest.json" "$ROOT/background.html" "$ROOT/background.js" "$ROOT/core" "$ROOT/platform" \
      "$ROOT/experiments" "$ROOT/ui" "$ROOT/icons" "$ROOT/_locales" "$WORK/ext/"
cp "$HERE/scenario.js" "$WORK/ext/e2e.js"
cp -r "$HERE/probe" "$WORK/ext/e2eprobe"
cat > "$WORK/ext/e2e-config.json" <<EOF
{ "base": "http://127.0.0.1:$PORT", "ewsUrl": "http://127.0.0.1:$PORT/EWS/Exchange.asmx",
  "email": "anna.test@example.org", "username": "EXAMPLE\\\\atest", "password": "Geheim!123" }
EOF
python3 - "$WORK/ext" <<'PY'
import json, sys, os
d = sys.argv[1]
m = json.load(open(os.path.join(d, "manifest.json")))
m["experiment_apis"]["e2eprobe"] = {"schema": "e2eprobe/schema.json", "parent": {"scopes": ["addon_parent"], "events": ["startup"], "paths": [["e2eprobe"]], "script": "e2eprobe/parent.js"}}
m["permissions"] += ["accountsRead", "messagesRead", "messagesUpdate", "messagesMove", "compose", "compose.send", "http://127.0.0.1/*"]
json.dump(m, open(os.path.join(d, "manifest.json"), "w"), indent=2)
p = os.path.join(d, "background.html")
html = open(p).read()
open(p, "w").write(html.replace('</body>', '<script type="module" src="e2e.js"></script></body>'))

PY
echo "$WORK/ext/" > "$WORK/profile/extensions/$ID"

cat > "$WORK/profile/user.js" <<'EOF'
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.experiments.enabled", true);
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mail.shell.checkDefaultClient", false);
user_pref("mailnews.start_page.enabled", false);
user_pref("mail.rights.version", 1);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.update.disabledForTesting", true);
user_pref("mail.spotlight.firstRunDone", true);
user_pref("mail.winsearch.firstRunDone", true);
user_pref("mail.biff.show_alert", false);
user_pref("devtools.console.stdout.chrome", true);
user_pref("devtools.console.stdout.content", true);
user_pref("browser.dom.window.dump.enabled", true);
user_pref("mailnews.oauth.useExternalBrowser", false);
user_pref("extensions.webextensions.background-delayed-startup", false);
user_pref("extensions.logging.enabled", true);
// A profile without any mail account blocks extension startup until the
// account wizard completes; this skips the wizard.
user_pref("app.use_without_mail_account", true);
user_pref("extensions.ewsbridge.debug", true);
EOF

deno run -A "$ROOT/tests/e2e/server.mjs" "$PORT" "$WORK/report.json" > "$WORK/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; [ -n "${TB:-}" ] && kill $TB 2>/dev/null || true' EXIT
sleep 1

# Thunderbird starts WebExtensions only after its main window has painted,
# which never happens with --headless. Preferred: an off-screen compositor,
#   kwin_wayland --virtual --no-lockscreen --socket wl-e2e &
# and E2E_WAYLAND=wl-e2e. Without it we fall back to --headless.
start_tb() {
  if [ -n "${E2E_WAYLAND:-}" ]; then
    env -u DISPLAY WAYLAND_DISPLAY="$E2E_WAYLAND" MOZ_ENABLE_WAYLAND=1 MOZ_LOG="${E2E_MOZLOG:-}" MOZ_LOG_FILE="$WORK/moz-$1.log" \
      thunderbird --no-remote --profile "$WORK/profile" >> "$WORK/thunderbird.log" 2>&1 &
  else
    MOZ_LOG="${E2E_MOZLOG:-}" MOZ_LOG_FILE="$WORK/moz-$1.log" MOZ_HEADLESS=1 thunderbird --headless --no-remote --profile "$WORK/profile" >> "$WORK/thunderbird.log" 2>&1 &
  fi
  TB=$!
}

for phase in 1 2; do
  rm -f "$WORK/report.json"
  if [ $phase = 2 ]; then
    # An account exists now: start normally (loads the mail UI and runs the startup mail check).
    sed -i 's/"app.use_without_mail_account", true/"app.use_without_mail_account", false/' "$WORK/profile/user.js"
  fi
  start_tb $phase
  echo "phase $phase: Thunderbird pid $TB (max ${TIMEOUT}s)…"
  for i in $(seq 1 "$TIMEOUT"); do
    [ -f "$WORK/report.json" ] && break
    kill -0 $TB 2>/dev/null || { echo "Thunderbird exited early"; break; }
    sleep 1
  done
  if [ -f "$WORK/report.json" ] && python3 -c "import json,sys; sys.exit(0 if json.load(open('$WORK/report.json'))['report']['done'] else 1)"; then
    sleep 2; kill $TB 2>/dev/null || true; wait $TB 2>/dev/null || true; TB=""
    break
  fi
  # phase 1 asks Thunderbird to quit itself (flushes prefs and passwords)
  for i in $(seq 1 30); do kill -0 $TB 2>/dev/null || break; sleep 1; done
  kill $TB 2>/dev/null || true; wait $TB 2>/dev/null || true; TB=""
done

if [ ! -f "$WORK/report.json" ]; then
  echo "NO REPORT. Last Thunderbird output:"; tail -40 "$WORK/thunderbird.log"; exit 1
fi

python3 - "$WORK" <<'PY'
import json, sys, os
work = sys.argv[1]
r = json.load(open(os.path.join(work, "report.json")))
res = r["report"]["results"]
fails = [k for k, v in res.items() if not v["ok"]]
for line in r["report"]["log"]:
    print("  " + line)
print(f"\n{len(res) - len(fails)} passed, {len(fails)} failed" + (f": {fails}" if fails else ""))
print("Exchange requests:", r["state"]["requests"])
sys.exit(1 if fails else 0)
PY
