-- AlterTable
ALTER TABLE "features" ADD COLUMN     "repos" TEXT[] DEFAULT ARRAY[]::TEXT[];
