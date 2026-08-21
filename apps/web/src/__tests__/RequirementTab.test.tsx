import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { RequirementTab } from '../components/RequirementTab.js';
import type { RepoEntry } from '../hooks/useFeature.js';
import type { PrLink } from '../types/ui.js';

const REPO_META: RepoEntry[] = [
  {
    id: 'bff',
    side: 'server',
    description: 'BFF service',
    default_branch: 'version11/11.10.0/update-claude-md',
  },
  { id: 'swaggers', side: 'server', description: 'OpenAPI specs', default_branch: 'main' },
];

const BASE_PROPS = {
  requirement: 'Add a logout button to the header.',
  featurePath: 'FULL' as const,
  currentPhase: 'IMPLEMENTING' as const,
  repos: ['bff', 'swaggers'],
  repoMeta: REPO_META,
  currentBranches: {} as Record<string, string>,
  prLinks: [] as PrLink[],
  createdAt: '2026-08-16T10:00:00.000Z',
};

describe('RequirementTab', () => {
  it('renders the requirement text', () => {
    render(<RequirementTab {...BASE_PROPS} />);
    expect(screen.getByText('Add a logout button to the header.')).toBeInTheDocument();
  });

  it('per-repo table has one row per selected repo', () => {
    render(<RequirementTab {...BASE_PROPS} />);
    // header row + one row per repo
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(BASE_PROPS.repos.length + 1);
  });

  it('base branch matches the manifest entry for each repo', () => {
    render(<RequirementTab {...BASE_PROPS} />);
    expect(screen.getByText('version11/11.10.0/update-claude-md')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('shows a dash for a repo with no feature branch yet', () => {
    render(<RequirementTab {...BASE_PROPS} currentBranches={{}} />);
    // Both repos have no branch — should see at least one dash cell
    const dashes = screen.getAllByText('—');
    // At minimum two dashes (one per repo's feature-branch column)
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('renders a PR link once a pr.created event exists for a repo', () => {
    const prLinks: PrLink[] = [
      {
        repo: 'bff',
        prId: 42,
        prUrl: 'https://dev.azure.com/org/repo/pullrequest/42',
        title: 'feat: logout',
      },
    ];
    render(
      <RequirementTab
        {...BASE_PROPS}
        currentBranches={{ bff: 'feature/logout', swaggers: 'feature/logout' }}
        prLinks={prLinks}
      />,
    );
    const link = screen.getByRole('link', { name: /#42/ });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://dev.azure.com/org/repo/pullrequest/42');
  });
});
