import { describe, expect, it } from 'vitest';
import { FeatureSchema, MessageSchema } from '../types/feature.js';

const validFeature = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  slug: 'user-login',
  name: 'User Login',
  requirement: 'Allow users to log in',
  status: 'DRAFTING_SPEC' as const,
  proposed_spec: null,
  created_at: '2026-07-08T00:00:00.000Z',
};

describe('FeatureSchema', () => {
  it('parses a valid feature', () => {
    expect(() => FeatureSchema.parse(validFeature)).not.toThrow();
  });

  it('throws when a required field is missing', () => {
    const { name: _name, ...withoutName } = validFeature;
    expect(() => FeatureSchema.parse(withoutName)).toThrow();
  });

  it('throws when status is not a valid enum value', () => {
    expect(() => FeatureSchema.parse({ ...validFeature, status: 'INVALID' })).toThrow();
  });

  it('allows proposed_spec to be null', () => {
    const parsed = FeatureSchema.parse({ ...validFeature, proposed_spec: null });
    expect(parsed.proposed_spec).toBeNull();
  });

  it('allows proposed_spec to be a string', () => {
    const parsed = FeatureSchema.parse({ ...validFeature, proposed_spec: '# Spec' });
    expect(parsed.proposed_spec).toBe('# Spec');
  });
});

describe('MessageSchema', () => {
  const validMessage = {
    id: '223e4567-e89b-12d3-a456-426614174001',
    feature_id: '123e4567-e89b-12d3-a456-426614174000',
    role: 'user' as const,
    content_json: '[]',
    created_at: '2026-07-08T00:00:00.000Z',
  };

  it('parses a valid message', () => {
    expect(() => MessageSchema.parse(validMessage)).not.toThrow();
  });

  it('throws when role is invalid', () => {
    expect(() => MessageSchema.parse({ ...validMessage, role: 'system' })).toThrow();
  });
});
