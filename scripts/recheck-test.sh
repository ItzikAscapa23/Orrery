#!/usr/bin/env bash
# Criterion 5: request-changes → fresh review supersedes old findings.
# Needs the FIXED server code running (composite finding identity + cycle-scoped
# approve gate) and model access (VPN for Bedrock mode).
# Self-contained: parks a bait feature via bait-test.sh if none is waiting.
set -euo pipefail

BASE="${BASE:-http://localhost:3001}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }

find_parked() {
  curl -s "$BASE/features" | python3 -c "
import json,sys
fs=json.load(sys.stdin)
cands=[f for f in fs if f.get('status')=='AWAITING_APPROVAL' and f.get('name','').startswith('feedback-widget')]
cands.sort(key=lambda f: f.get('created_at',''), reverse=True)
print(cands[0]['id'] if cands else '')"
}

FID="${1:-$(find_parked)}"
if [ -z "$FID" ]; then
  say "No parked bait feature — running bait-test.sh first"
  "$SCRIPT_DIR/bait-test.sh"
  FID=$(find_parked)
  [ -n "$FID" ] || { echo "still no parked feature — aborting"; exit 1; }
fi
echo "feature: $FID"

events() { curl -s "$BASE/features/$FID/events/history?limit=500"; }

say "1/4 Capturing review-1 findings"
R1=$(events | python3 -c "
import json,sys
evs=json.load(sys.stdin)
rf=[e for e in evs if e['type']=='review.findings']
f=rf[-1]['payload']['findings'] if rf else []
blockers=[x['id'] for x in f if x['severity']=='blocker']
print(json.dumps({'n':len(f),'blockers':blockers,'first_blocker':blockers[0] if blockers else ''}))")
N1=$(echo "$R1" | python3 -c "import json,sys;print(json.load(sys.stdin)['n'])")
B1=$(echo "$R1" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['blockers']))")
OLD_BLOCKER=$(echo "$R1" | python3 -c "import json,sys;print(json.load(sys.stdin)['first_blocker'])")
echo "review 1: $N1 findings, $B1 blockers (will track '$OLD_BLOCKER')"
[ "$B1" -ge 1 ] || { echo "need at least one blocker in review 1 to prove supersession — aborting"; exit 1; }

say "2/4 request-changes (removing the bait) → Spec Agent re-proposes → fresh review"
curl -sN --max-time 300 -H 'Content-Type: application/json' \
  -d '{"comment":"Please revise: drop the weekly digest email entirely (no email at all, remove SendGrid) and store submissions in Amazon RDS PostgreSQL instead of DynamoDB, encrypted at rest, all resources pinned to eu-west-1, endpoints HTTPS-only behind the existing Cognito authoriser. Re-propose the spec NOW via save_spec."}' \
  "$BASE/features/$FID/request-changes" > /dev/null || true

deadline=$(( $(date +%s) + 300 ))
while :; do
  ST=$(curl -s "$BASE/features/$FID" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
  echo "  status: $ST"
  case "$ST" in AWAITING_APPROVAL|FAILED) break;; esac
  [ "$(date +%s)" -lt "$deadline" ] || { echo "timeout"; break; }
  sleep 5
done

say "3/4 Asserting supersession"
SUMMARY=$(events | python3 -c "
import json,sys
evs=json.load(sys.stdin)
rf=[e for e in evs if e['type']=='review.findings']
gr=[e for e in evs if e['type']=='gate.resolved' and e['payload'].get('resolution')=='changes_requested']
f2=rf[-1]['payload']['findings'] if len(rf)>=2 else []
b2=[x['id'] for x in f2 if x['severity']=='blocker']
print(json.dumps({'reviews':len(rf),'changes_requested':len(gr),'n2':len(f2),'b2':b2}))")
echo "  $SUMMARY"
REVIEWS=$(echo "$SUMMARY" | python3 -c "import json,sys;print(json.load(sys.stdin)['reviews'])")
B2=$(echo "$SUMMARY" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['b2']))")
[ "$REVIEWS" -ge 2 ] && ok "fresh review ran (review.findings ×$REVIEWS)" || bad "expected 2+ review.findings events, got $REVIEWS"

# Stale-finding check: finding labels restart at f1 every review cycle, and the
# accept/dismiss routes resolve a label against the CURRENT cycle by design.
# The 409-stale path is only observable for an old label that does NOT recur
# in review 2 — pick one; if every old label recurs, the approve-gate check in
# step 4 is the supersession proof and we skip this sub-check.
STALE_ID=$(events | python3 -c "
import json,sys
evs=json.load(sys.stdin)
rf=[e for e in evs if e['type']=='review.findings']
old={f['id'] for f in rf[0]['payload']['findings']} if rf else set()
new={f['id'] for f in rf[-1]['payload']['findings']} if len(rf)>=2 else set()
only_old=sorted(old-new)
print(only_old[0] if only_old else '')")
if [ -n "$STALE_ID" ]; then
  resp=$(curl -s -w '\n%{http_code}' -X POST "$BASE/features/$FID/findings/$STALE_ID/dismiss" -H 'Content-Type: application/json' -d '{"reason":"stale-check"}')
  code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
  if [ "$code" = "409" ] && echo "$body" | grep -q "belongs to spec revision"; then
    ok "old-only finding '$STALE_ID' is stale: $body"
  else bad "old-only finding '$STALE_ID' dismiss → $code (expected 409 stale): $body"; fi
else
  echo "  NOTE every review-1 label recurs in review 2 — 409-stale sub-check skipped; step 4's approve gate is the supersession proof"
fi

say "4/4 Approve gated ONLY by review-2 blockers ($B2)"
resp=$(curl -s -w '\n%{http_code}' -X POST "$BASE/features/$FID/approve")
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | sed '$d')
if [ "$B2" -eq 0 ]; then
  if [ "$code" = "200" ]; then ok "approve 200 — old unresolved blockers did not gate"; else bad "expected 200 (no new blockers), got $code: $body"; fi
else
  if [ "$code" = "409" ] && echo "$body" | grep -q "^{\"error\":\"$B2 blocker"; then
    ok "approve 409 counts exactly the $B2 current-cycle blocker(s): $body"
  elif [ "$code" = "409" ]; then
    echo "$body" | grep -q "$B2 blocker" && ok "approve 409 counts exactly $B2 current-cycle blocker(s)" || bad "409 but wrong count (expected $B2): $body"
  else bad "expected 409 with $B2 blockers, got $code: $body"; fi
  echo "  (feature left parked at the gate with review-2 findings for UI inspection)"
fi

curl -s "$BASE/features/$FID" > "$SCRIPT_DIR/run5-feature.json"
events > "$SCRIPT_DIR/run5-events.json"
echo
printf '\033[1mCriterion 5: %d passed, %d failed\033[0m  (evidence: run5-*.json)\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
