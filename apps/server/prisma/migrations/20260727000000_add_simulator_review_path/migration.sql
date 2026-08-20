-- Phase 5: store the simulator's CODE_REVIEW sub-path choice per feature
ALTER TABLE features ADD COLUMN simulator_review_path TEXT;
