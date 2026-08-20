-- CreateTable
CREATE TABLE "model_rates" (
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "input_per_m_token" DOUBLE PRECISION NOT NULL,
    "output_per_m_token" DOUBLE PRECISION NOT NULL,
    "cache_write_per_m_token" DOUBLE PRECISION,
    "cache_read_per_m_token" DOUBLE PRECISION,

    CONSTRAINT "model_rates_pkey" PRIMARY KEY ("provider","model","effective_from")
);
