-- Replace the single current_branch column (T-4c-1) with a per-repo JSON map.
-- Existing rows have their branch value migrated into the map keyed by 'demo-server'
-- (the only active server repo at time of migration; current_branch always held feature/<slug>).
ALTER TABLE features
  ADD COLUMN current_branches JSONB NOT NULL DEFAULT '{}';

UPDATE features
  SET current_branches = jsonb_build_object('demo-server', current_branch)
  WHERE current_branch IS NOT NULL;

ALTER TABLE features
  DROP COLUMN current_branch;
