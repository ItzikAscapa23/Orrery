-- Findings are identified by (feature, review cycle, model-assigned id).
-- The old single-column PK on "id" made every second review collide on "f1".
ALTER TABLE "findings" DROP CONSTRAINT "findings_pkey";
ALTER TABLE "findings" ADD CONSTRAINT "findings_pkey" PRIMARY KEY ("feature_id", "spec_rev", "id");
