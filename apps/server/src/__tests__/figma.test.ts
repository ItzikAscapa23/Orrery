import { describe, expect, it } from 'vitest';
import { parseFigmaUrl } from '../lib/figma.js';

describe('parseFigmaUrl', () => {
  it('parses a figma.com/file URL with node-id', () => {
    const result = parseFigmaUrl('https://www.figma.com/file/ABC123xyz/MyDesign?node-id=10:20');
    expect(result).toEqual({ fileKey: 'ABC123xyz', nodeId: '10:20' });
  });

  it('parses a figma.com/design URL with node-id', () => {
    const result = parseFigmaUrl('https://www.figma.com/design/XYZ789/App?node-id=5:42&t=abc');
    expect(result).toEqual({ fileKey: 'XYZ789', nodeId: '5:42' });
  });

  it('parses a figma.com/file URL without node-id', () => {
    const result = parseFigmaUrl('https://www.figma.com/file/KEYonly/Design');
    expect(result).toEqual({ fileKey: 'KEYonly', nodeId: '' });
  });

  it('returns null for a non-Figma URL', () => {
    expect(parseFigmaUrl('https://example.com/file/ABC?node-id=1:2')).toBeNull();
  });

  it('finds a Figma URL embedded in a sentence', () => {
    const text =
      'Please look at this design: https://www.figma.com/file/EMBED123/UI?node-id=3:7 and let me know';
    const result = parseFigmaUrl(text);
    expect(result).toEqual({ fileKey: 'EMBED123', nodeId: '3:7' });
  });

  it('converts dash-encoded node-id to colon format for the Figma API', () => {
    // Figma URLs encode node IDs as '1-2' but the REST API expects '1:2'
    const result = parseFigmaUrl(
      'https://www.figma.com/design/QbFeSXvqHtCubOVjToF3Px/Untitled?node-id=1-2&t=abc',
    );
    expect(result).toEqual({ fileKey: 'QbFeSXvqHtCubOVjToF3Px', nodeId: '1:2' });
  });

  it('returns null for plain text with no URL', () => {
    expect(parseFigmaUrl('just some text about figma without a URL')).toBeNull();
  });
});
