import type Anthropic from '@anthropic-ai/sdk';

const FIGMA_URL_RE =
  /figma\.com\/(?:file|design)\/([A-Za-z0-9_-]+)(?:\/[^?#]*)?(?:[?&]node-id=([^&#\s]+))?/;

export interface FigmaRef {
  fileKey: string;
  nodeId: string;
}

export function parseFigmaUrl(text: string): FigmaRef | null {
  const match = FIGMA_URL_RE.exec(text);
  if (!match || !match[1]) return null;
  // Figma URLs encode node IDs with '-' instead of ':' (e.g. node-id=1-2 → API id 1:2)
  const rawNodeId = match[2] ?? '';
  return {
    fileKey: match[1],
    nodeId: rawNodeId.replace('-', ':'),
  };
}

export async function fetchFigmaImage(
  fileKey: string,
  nodeId: string,
): Promise<Anthropic.ImageBlockParam.Source> {
  const token = process.env['FIGMA_TOKEN'];
  if (!token) {
    throw new Error('FIGMA_TOKEN env var is not set');
  }

  const idsParam = nodeId ? nodeId : '0:0';
  const apiUrl = `https://api.figma.com/v1/images/${fileKey}?ids=${idsParam}&format=png`;

  const apiRes = await fetch(apiUrl, { headers: { 'X-Figma-Token': token } });
  if (!apiRes.ok) {
    throw new Error(`Figma API error: ${apiRes.status} ${apiRes.statusText}`);
  }

  const apiJson = (await apiRes.json()) as { images?: Record<string, string | null> };
  const imageUrl = apiJson.images?.[idsParam];
  if (!imageUrl) {
    throw new Error(`Figma did not return an image URL for node ${idsParam}`);
  }

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download Figma image: ${imgRes.status} ${imgRes.statusText}`);
  }

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  return {
    type: 'base64',
    media_type: 'image/png',
    data: buffer.toString('base64'),
  };
}
