-- CreateTable
CREATE TABLE "spec_questions" (
    "id" TEXT NOT NULL,
    "feature_id" TEXT NOT NULL,
    "spec_rev" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "resolution" TEXT,
    "answer" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spec_questions_pkey" PRIMARY KEY ("feature_id","spec_rev","id")
);

-- AddForeignKey
ALTER TABLE "spec_questions" ADD CONSTRAINT "spec_questions_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE CASCADE ON UPDATE CASCADE;
