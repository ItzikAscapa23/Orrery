#!/usr/bin/env bash
# feedback-widget bait test — drives the local Orrery server end-to-end
# and dumps the resulting events + findings for verification.
# Usage: ./bait-test.sh   (server must be running; BASE overridable, default :3001)
set -euo pipefail

BASE="${BASE:-http://localhost:3001}"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="feedback-widget"
REQ="Users can submit feedback text from the app. Store submissions in DynamoDB and email a weekly digest to the product team via SendGrid."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
jsonget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)"; }

say "1/5 Health check ($BASE)"
curl -sf "$BASE/health" >/dev/null || { echo "Server not reachable at $BASE — is 'npm run dev' running?"; exit 1; }
echo "ok"

say "2/5 Creating feature '$NAME'"
create_payload=$(python3 -c "import json;print(json.dumps({'name':'$NAME','requirement':'''$REQ'''}))")
resp=$(curl -s -w '\n%{http_code}' -H 'Content-Type: application/json' -d "$create_payload" "$BASE/features")
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
if [ "$code" = "409" ]; then
  NAME="feedback-widget-$(date +%s)"
  echo "name taken, retrying as $NAME"
  create_payload=$(python3 -c "import json;print(json.dumps({'name':'$NAME','requirement':'''$REQ'''}))")
  resp=$(curl -s -w '\n%{http_code}' -H 'Content-Type: application/json' -d "$create_payload" "$BASE/features")
  code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
fi
[ "$code" = "201" ] || { echo "create failed ($code): $body"; exit 1; }
FID=$(echo "$body" | jsonget "['id']")
echo "feature id: $FID"

send_msg() {
  # POST /messages responds as an SSE stream; consume it fully (turn ends when stream closes)
  curl -sN --max-time 300 -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json,sys;print(json.dumps({'text':sys.argv[1]}))" "$1")" \
    "$BASE/features/$FID/messages" > /dev/null || true
}

status() { curl -s "$BASE/features/$FID" | jsonget "['status']"; }

say "3/5 Driving Spec Agent (keeping the bait intact)"
send_msg "Requirement: $REQ  No designs. Please make reasonable assumptions for everything else and propose the spec NOW via save_spec. Keep the storage and email choices exactly as stated: DynamoDB for submissions, SendGrid for the weekly digest."
tries=0
while [ "$(status)" = "DRAFTING_SPEC" ] && [ $tries -lt 3 ]; do
  tries=$((tries+1))
  echo "still drafting (attempt $tries) — nudging agent to save_spec"
  send_msg "No further input. Propose the spec now with save_spec, making reasonable assumptions. Do not change the tech choices: DynamoDB storage, SendGrid weekly digest email."
done

say "4/5 Waiting for AWS review to finish (up to 240s)"
deadline=$(( $(date +%s) + 240 ))
while :; do
  st=$(status)
  echo "  status: $st"
  case "$st" in
    AWAITING_APPROVAL|FAILED) break ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || { echo "timeout waiting for review"; break; }
  sleep 5
done

say "5/5 Dumping results to $OUT_DIR"
curl -s "$BASE/features/$FID" > "$OUT_DIR/bait-feature.json"
curl -s "$BASE/features/$FID/events/history?limit=500" > "$OUT_DIR/bait-events.json"
python3 - "$OUT_DIR" <<'PY'
import json, sys
out = sys.argv[1]
events = json.load(open(f"{out}/bait-events.json"))
evs = events if isinstance(events, list) else events.get('events', events)
findings = []
for e in evs:
    if e.get('type') == 'review.findings':
        findings = e['payload'].get('findings', e.get('payload', {}).get('findings', []))
print(f"events: {len(evs)}")
print(f"review.findings entries: {len(findings)}")
for f in findings:
    print(f"  [{f['severity'].upper():10}] {f['id']} ({f['section']}): {f['issue'][:110]}")
dyn = any('dynamo' in json.dumps(f).lower() for f in findings)
sg  = any('sendgrid' in json.dumps(f).lower() for f in findings)
print(f"\nDynamoDB flagged: {dyn}")
print(f"SendGrid flagged: {sg}")
PY
echo
echo "Done. Files written: $OUT_DIR/bait-feature.json, $OUT_DIR/bait-events.json"
echo "Tell Claude the run is complete."
