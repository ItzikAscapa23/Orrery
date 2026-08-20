-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "orphan_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "park_reason" TEXT;
