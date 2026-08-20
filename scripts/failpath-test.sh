#!/usr/bin/env bash
# Box 7: review-failure path. Injects a deterministic AWS-review failure by hiding
# the charter file (re-read on every review; the Spec Agent is untouched), drives a
# fresh feature to save_spec, and asserts the machine still reaches AWAITING_APPROVAL
# with agent.status(failed) + the "review unavailable" log. Restores the charter on exit.
#
# NOTE: do not run while another feature is mid-review — the charter is hidden globally
# for the duration (~1-2 min).
set -euo pipefail

BASE="${BASE:-http://localhost:3001}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR/..")}"
CHARTER="$REPO/docs/agents/aws-charter.md"
HIDDEN="$CHARTER.failpath-hidden"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f "$CHARTER" ] || { echo "charter not found at $CHARTER"; exit 1; }

restore() {
  if [ -f "$HIDDEN" ]; then mv "$HIDDEN" "$CHARTER"; echo "(charter restored)"; fi
}
trap restore EXIT

say "1/4 Hiding charter (failure injection)"
mv "$CHARTER" "$HIDDEN"
echo "hidden: $CHARTER"

say "2/4 Creating fresh feature and driving to save_spec"
NAME="feedback-failpath-$(date +%s)"
resp=$(curl -s -w '\n%{http_code}' -H 'Content-Type: application/json' \
  -d "{\"name\":\"$NAME\",\"requirement\":\"Add a read-only About screen showing the app version and a support email address.\"}" \
  "$BASE/features")
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
[ "$code" = "201" ] || { echo "create failed ($code): $body"; exit 1; }
FID=$(echo "$body" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "feature id: $FID"

curl -sN --max-time 300 -H 'Content-Type: application/json' \
  -d '{"text":"No designs, no open questions. Static content only. Make reasonable assumptions and propose the spec NOW via save_spec."}' \
  "$BASE/features/$FID/messages" > /dev/null || true

say "3/4 Waiting for the machine to pass through the failed review (up to 120s)"
deadline=$(( $(date +%s) + 120 ))
while :; do
  ST=$(curl -s "$BASE/features/$FID" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
  echo "  status: $ST"
  case "$ST" in AWAITING_APPROVAL|FAILED) break;; esac
  [ "$(date +%s)" -lt "$deadline" ] || { echo "timeout"; break; }
  sleep 4
done

say "4/4 Asserting the failure contract"
curl -s "$BASE/features/$FID" > "$SCRIPT_DIR/run4-feature.json"
curl -s "$BASE/features/$FID/events/history?limit=500" > "$SCRIPT_DIR/run4-events.json"
RES=$(python3 - "$SCRIPT_DIR" <<'PY'
import json,sys
evs=json.load(open(f"{sys.argv[1]}/run4-events.json"))
evs=evs if isinstance(evs,list) else evs.get('events',evs)
feat=json.load(open(f"{sys.argv[1]}/run4-feature.json"))
aws=[e for e in evs if e.get('agent')=='aws']
failed=[e for e in aws if e['type']=='agent.status' and e['payload'].get('status')=='failed']
unavail=[e for e in aws if e['type']=='agent.log' and 'review unavailable' in e['payload'].get('text','')]
findings=[e for e in evs if e['type']=='review.findings']
gates=[e for e in evs if e['type']=='gate.opened']
gate_no_counts = bool(gates) and 'counts' not in gates[-1]['payload']
checks = {
 'status_awaiting_approval': feat['status']=='AWAITING_APPROVAL',
 'aws_status_failed': len(failed)>=1,
 'unavailable_log_line': len(unavail)>=1,
 'no_review_findings_event': len(findings)==0,
 'gate_opened_without_counts': gate_no_counts,
}
for k,v in checks.items(): print(('PASS ' if v else 'FAIL ')+k)
print(f"INFO aws failed-status events: {len(failed)} (spec 03 says the job should retry once => 2 expected; enqueueJob sets no BullMQ attempts and the job catches internally, so 1 is current behaviour)")
PY
)
echo "$RES" | while read -r line; do
  case "$line" in
    PASS\ *) printf '  \033[32mPASS\033[0m %s\n' "${line#PASS }";;
    FAIL\ *) printf '  \033[31mFAIL\033[0m %s\n' "${line#FAIL }";;
    INFO\ *) printf '  NOTE %s\n' "${line#INFO }";;
  esac
done
FAILS=$(echo "$RES" | grep -c '^FAIL' || true)

restore
trap - EXIT
grep -q "AWS Expert Agent Charter" "$CHARTER" && echo "charter verified restored" || { echo "CHARTER RESTORE FAILED — check $HIDDEN"; exit 1; }

echo
if [ "$FAILS" -eq 0 ]; then printf '\033[1mBox 7: all checks passed\033[0m\n'; else printf '\033[1mBox 7: %s check(s) failed\033[0m\n' "$FAILS"; exit 1; fi