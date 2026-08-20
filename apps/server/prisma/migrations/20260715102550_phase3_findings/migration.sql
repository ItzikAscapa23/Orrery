-- CreateTable
CREATE TABLE "findings" (
    "id" TEXT NOT NULL,
    "feature_id" TEXT NOT NULL,
    "spec_rev" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "issue" TEXT NOT NULL,
    "suggested_text" TEXT,
    "resolution" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE CASCADE ON UPDATE CASCADE;
