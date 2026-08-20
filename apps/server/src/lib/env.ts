import { z } from 'zod';

const EnvSchema = z
  .object({
    ANTHROPIC_PROVIDER: z.enum(['anthropic', 'bedrock']).default('anthropic'),
    ANTHROPIC_API_KEY: z.string().optional(),
    // Bedrock credentials — required when ANTHROPIC_PROVIDER=bedrock
    AWS_REGION: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    // Optional: override the model ID for Bedrock (e.g. an application inference
    // profile ARN). When set, all model calls use this value instead of the
    // normalised foundation-model ID. Required when org policy restricts access
    // to specific inference profiles rather than foundation-model ARNs.
    BEDROCK_MODEL_ID: z.string().optional(),
    ARTIFACTS_REPO_PATH: z.string().min(1),
    FIGMA_TOKEN: z.string().optional(),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    PORT: z.string().default('3001'),
  })
  .superRefine((data, ctx) => {
    if (data.ANTHROPIC_PROVIDER === 'anthropic') {
      if (!data.ANTHROPIC_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ANTHROPIC_API_KEY'],
          message: 'ANTHROPIC_API_KEY is required when ANTHROPIC_PROVIDER=anthropic',
        });
      }
    }
    if (data.ANTHROPIC_PROVIDER === 'bedrock') {
      if (!data.AWS_REGION) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AWS_REGION'],
          message: 'AWS_REGION is required when ANTHROPIC_PROVIDER=bedrock',
        });
      }
    }
  });

function parseEnv() {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid environment variables: ${messages}`);
  }
  return result.data;
}

export const env = parseEnv();
