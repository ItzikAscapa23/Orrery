#!/usr/bin/env bash
# Boxes 4-6: approve gate 409 → accept 2 suggested-text blockers → dismiss the rest → approve.
# Self-sufficient: finds the parked feedback-widget feature and reads its real findings.
# Usage: ./gate-test.sh [feature-id]      (BASE overridable, default :3001)
set -euo pipefail

BASE="${BASE:-http://localhost:3001}"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
req()  { local m="$1" p="$2" d="${3:-}"; local r
  if [ -n "$d" ]; then r=$(curl -s -w '\n%{http_code}' -X "$m" -H 'Content-Type: application/json' -d "$d" "$BASE$p")
  else r=$(curl -s -w '\n%{http_code}' -X "$m" "$BASE$p"); fi
  CODE=$(echo "$r" | tail -1); BODY=$(echo "$r" | sed '$d'); }

# --- resolve feature ---
if [ $# -ge 1 ]; then FID="$1"; else
  FID=$(curl -s "$BASE/features" | python3 -c "
import json,sys
fs=json.load(sys.stdin)
cands=[f for f in fs if f.get('status')=='AWAITING_APPROVAL' and f.get('name','').startswith('feedback-widget')]
cands.sort(key=lambda f: f.get('created_at',''), reverse=True)
print(cands[0]['id'] if cands else '')")
fi
if [ -z "$FID" ]; then
  echo "No feedback-widget feature in AWAITING_APPROVAL found. Current features:"
  curl -s "$BASE/features" | python3 -c "
import json,sys
for f in json.load(sys.stdin): print(f\"  {f['id']}  {f['name']:40} {f['status']}\")" || true
  echo "Run ./bait-test.sh first to park a fresh bait feature at the gate, then re-run this."
  exit 1
fi
echo "feature: $FID"

# --- load findings from the last review.findings event ---
FINDINGS_JSON=$(curl -s "$BASE/features/$FID/events/history?limit=500" | python3 -c "
import json,sys
evs=json.load(sys.stdin)
if isinstance(evs,dict): sys.exit('unexpected response: '+json.dumps(evs)[:200])
rf=[e for e in evs if e['type']=='review.findings']
resolved={e['payload']['finding_id'] for e in evs if e['type']=='finding.resolved'}
out=[f for f in (rf[-1]['payload']['findings'] if rf else []) if f['id'] not in resolved]
print(json.dumps(out))")
N_BLOCK=$(echo "$FINDINGS_JSON" | python3 -c "import json,sys;print(sum(1 for f in json.load(sys.stdin) if f['severity']=='blocker'))")
ACCEPTS=$(echo "$FINDINGS_JSON" | python3 -c "
import json,sys
fs=json.load(sys.stdin)
picks=[f['id'] for f in fs if f['severity']=='blocker' and f.get('suggested_text')][:2]
print(' '.join(picks))")
echo "unresolved blockers: $N_BLOCK | will accept: ${ACCEPTS:-none}"
[ "$N_BLOCK" -ge 1 ] || { echo "No unresolved blockers — nothing to gate-test. (Re-run bait-test.sh for a fresh feature.)"; exit 1; }

spec_hash() { curl -s "$BASE/features/$FID" | python3 -c "import json,sys,hashlib;print(hashlib.md5((json.load(sys.stdin).get('proposed_spec') or '').encode()).hexdigest())"; }
revs() { curl -s "$BASE/features/$FID/events/history?limit=500" | python3 -c "
import json,sys
evs=json.load(sys.stdin)
print([e['payload'].get('rev') for e in evs if e['type']=='spec.revised'] if isinstance(evs,list) else 'n/a')"; }

say "Box 4: APPROVE must refuse with $N_BLOCK unresolved blocker(s)"
req POST "/features/$FID/approve"
if [ "$CODE" = "409" ] && echo "$BODY" | grep -qi "blocker"; then ok "409: $BODY"; else bad "expected 409 blocker-gate, got $CODE: $BODY"; fi

say "Box 5: accept suggested-text blockers consecutively"
for fid_ in $ACCEPTS; do
  H_BEFORE=$(spec_hash)
  req POST "/features/$FID/findings/$fid_/accept"
  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ] || [ "$CODE" = "204" ]; then ok "accept $fid_ -> $CODE"; else bad "accept $fid_ -> $CODE: $BODY"; continue; fi
  H_AFTER=$(spec_hash)
  [ "$H_BEFORE" != "$H_AFTER" ] && ok "proposed_spec changed after accepting $fid_" || bad "proposed_spec unchanged after accepting $fid_"
done
echo "  NOTE spec.revised revs so far: $(revs) (equal revs within one review cycle is current code behaviour: rev = gate.opened count)"

say "Box 6: dismiss remaining blockers with reasons, then approve"
REMAINING=$(curl -s "$BASE/features/$FID/events/history?limit=500" | python3 -c "
import json,sys
evs=json.load(sys.stdin)
rf=[e for e in evs if e['type']=='review.findings']
resolved={e['payload']['finding_id'] for e in evs if e['type']=='finding.resolved'}
print(' '.join(f['id'] for f in rf[-1]['payload']['findings'] if f['severity']=='blocker' and f['id'] not in resolved))")
first=1
for fid_ in $REMAINING; do
  if [ "$first" = "1" ]; then
    REASON="Severity inflated relative to the charter: the underlying concern is off-charter service usage / missing confirmation, not a concrete violation (no non-HTTPS endpoint or cross-region data path exists in the spec). Recording board sign-off follow-up instead."
    first=0
  else
    REASON="Descoped pending architecture board sign-off; the affected capability will not ship until the approved-services amendment lands, so no policy violation exists at implementation time."
  fi
  req POST "/features/$FID/findings/$fid_/dismiss" "$(python3 -c "import json,sys;print(json.dumps({'reason':sys.argv[1]}))" "$REASON")"
  if [ "$CODE" = "200" ] || [ "$CODE" = "204" ]; then ok "dismiss $fid_ -> $CODE"; else bad "dismiss $fid_ -> $CODE: $BODY"; fi
done

req POST "/features/$FID/approve"
if [ "$CODE" = "200" ] || [ "$CODE" = "204" ]; then ok "APPROVE unlocked -> $CODE"; else bad "approve -> $CODE: $BODY"; fi

sleep 2
ST=$(curl -s "$BASE/features/$FID" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
[ "$ST" = "PLANNING" ] && ok "feature advanced to PLANNING" || bad "status is $ST, expected PLANNING"

say "Dumping evidence"
curl -s "$BASE/features/$FID" > "$OUT_DIR/run3-feature.json"
curl -s "$BASE/features/$FID/events/history?limit=500" > "$OUT_DIR/run3-events.json"
python3 - "$OUT_DIR" <<'PY'
import json,sys
evs=json.load(open(f"{sys.argv[1]}/run3-events.json"))
if isinstance(evs,list):
    for t in ['finding.resolved','spec.revised','gate.resolved','artifact.committed','phase.changed']:
        hits=[e['payload'] for e in evs if e['type']==t]
        print(f"  {t}: {len(hits)}")
        for h in hits[-3:]: print("    ", json.dumps({k:v for k,v in h.items() if k!='type'})[:160])
PY
echo
printf '\033[1mResult: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]