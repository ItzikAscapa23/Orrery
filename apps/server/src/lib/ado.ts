export interface CreatePrInput {
  orgUrl: string; // e.g. 'https://dev.azure.com/myorg'
  project: string; // e.g. 'my-project'
  repoId: string; // e.g. 'demo-server'
  pat: string;
  title: string;
  description: string;
  sourceBranch: string; // 'refs/heads/feature/<slug>'
  targetBranch: string; // 'refs/heads/main'
}

export interface CreatedPr {
  prId: number;
  prUrl: string;
}

/**
 * Open a pull request in Azure DevOps via the REST API.
 * Auth: HTTP Basic with an empty username and the PAT as password.
 * Throws a descriptive Error on any non-2xx response.
 */
export async function createAdoPullRequest(input: CreatePrInput): Promise<CreatedPr> {
  const { orgUrl, project, repoId, pat, title, description, sourceBranch, targetBranch } = input;
  const url = `${orgUrl}/${project}/_apis/git/repositories/${repoId}/pullrequests?api-version=7.1`;

  const auth = Buffer.from(`:${pat}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      description,
      sourceRefName: sourceBranch,
      targetRefName: targetBranch,
    }),
  });

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore read failure
    }
    throw new Error(
      `ADO PR creation failed for ${repoId}: HTTP ${res.status} — ${body.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as {
    pullRequestId: number;
    _links?: { web?: { href?: string } };
  };

  const prId = data.pullRequestId;
  // Prefer the web link from _links.web.href; fall back to the constructed _git URL.
  // Never use data.url — it is the REST API resource URL, not the browser-navigable URL.
  const prUrl = data._links?.web?.href ?? `${orgUrl}/${project}/_git/${repoId}/pullrequest/${prId}`;

  return { prId, prUrl };
}

/**
 * Parse an Azure DevOps Git URL into its constituent parts.
 * Handles both visualstudio.com and dev.azure.com URL formats.
 *
 * visualstudio.com: https://{org}.visualstudio.com/{project}/_git/{repo}
 * dev.azure.com:    https://dev.azure.com/{org}/{project}/_git/{repo}
 */
export function parseAdoRepoUrl(repoUrl: string): {
  orgUrl: string;
  project: string;
  repoId: string;
} {
  const vstsMatch = repoUrl.match(/^(https:\/\/[^/]+\.visualstudio\.com)\/([^/]+)\/_git\/([^/]+)/);
  if (vstsMatch) {
    return { orgUrl: vstsMatch[1]!, project: vstsMatch[2]!, repoId: vstsMatch[3]! };
  }

  const devMatch = repoUrl.match(/^(https:\/\/dev\.azure\.com)\/([^/]+)\/([^/]+)\/_git\/([^/]+)/);
  if (devMatch) {
    const orgUrl = `${devMatch[1]!}/${devMatch[2]!}`;
    return { orgUrl, project: devMatch[3]!, repoId: devMatch[4]! };
  }

  throw new Error(`Cannot parse ADO repo URL: ${repoUrl}`);
}
