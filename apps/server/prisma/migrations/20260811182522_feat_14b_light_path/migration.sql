-- CreateEnum
CREATE TYPE "FeaturePath" AS ENUM ('FULL', 'LIGHT');

-- AlterEnum
ALTER TYPE "FeatureStatus" ADD VALUE 'LIGHT_IMPLEMENTING';

-- AlterTable
ALTER TABLE "features" ADD COLUMN     "feature_path" "FeaturePath" NOT NULL DEFAULT 'FULL';
