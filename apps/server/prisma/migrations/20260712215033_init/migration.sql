-- CreateEnum
CREATE TYPE "FeatureStatus" AS ENUM ('DRAFTING_SPEC', 'AWS_REVIEW', 'AWAITING_APPROVAL', 'PLANNING', 'IMPLEMENTING', 'CODE_REVIEW', 'TESTING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "features" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "status" "FeatureStatus" NOT NULL DEFAULT 'DRAFTING_SPEC',
    "proposed_spec" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "feature_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content_json" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" BIGSERIAL NOT NULL,
    "feature_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "agent" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "features_slug_key" ON "features"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "events_feature_id_seq_key" ON "events"("feature_id", "seq");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE CASCADE ON UPDATE CASCADE;
