-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FeatureStatus" ADD VALUE 'PLANNING_TESTS';
ALTER TYPE "FeatureStatus" ADD VALUE 'AWAITING_TEST_PLAN_APPROVAL';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "covered_by_test_plan" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tests_written" BOOLEAN NOT NULL DEFAULT false;
