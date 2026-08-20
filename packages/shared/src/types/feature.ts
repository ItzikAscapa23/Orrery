import { z } from 'zod';

export const FeatureStatusSchema = z.enum(['DRAFTING_SPEC', 'SPEC_APPROVED']);

export const FeatureSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  requirement: z.string(),
  status: FeatureStatusSchema,
  proposed_spec: z.string().nullable(),
  repos: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  review_skipped: z.boolean().default(false),
});

export const MessageRoleSchema = z.enum(['user', 'assistant']);

export const MessageSchema = z.object({
  id: z.string().uuid(),
  feature_id: z.string().uuid(),
  role: MessageRoleSchema,
  content_json: z.string(),
  created_at: z.string().datetime(),
});

export type Feature = z.infer<typeof FeatureSchema>;
export type FeatureStatus = z.infer<typeof FeatureStatusSchema>;
export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type Message = z.infer<typeof MessageSchema>;
