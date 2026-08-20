import { useCallback, useEffect, useState } from 'react';

export interface FeatureSummary {
  id: string;
  slug: string;
  name: string;
  requirement: string;
  status: string;
  proposed_spec: string | null;
  repos: string[];
  feature_path: 'FULL' | 'LIGHT';
  current_branches: Record<string, string>;
  created_at: string;
  review_skipped: boolean;
}

export interface RepoEntry {
  id: string;
  side: string;
  description: string;
  default_branch: string;
}

interface UseFeatureResult {
  features: FeatureSummary[];
  selectedId: string | null;
  selectFeature: (id: string | null) => void;
  createFeature: (name: string, requirement: string, repos: string[]) => Promise<FeatureSummary>;
  loadRepos: () => Promise<RepoEntry[]>;
  refreshFeatures: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

function idFromPath(): string | null {
  const m = window.location.pathname.match(/^\/features\/([^/]+)$/);
  return m ? (m[1] ?? null) : null;
}

export function useFeature(): UseFeatureResult {
  const [features, setFeatures] = useState<FeatureSummary[]>([]);
  // Initialise from the URL so refresh and direct navigation restore the view.
  const [selectedId, setSelectedId] = useState<string | null>(idFromPath);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshFeatures = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/features');
      if (!res.ok) throw new Error(`Failed to load features: ${res.status}`);
      const data = (await res.json()) as FeatureSummary[];
      setFeatures(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshFeatures();
  }, [refreshFeatures]);

  // Sync selectedId from URL on browser back/forward.
  useEffect(() => {
    const onPop = () => setSelectedId(idFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const selectFeature = useCallback((id: string | null) => {
    const path = id ? `/features/${id}` : '/';
    window.history.pushState({}, '', path);
    setSelectedId(id);
  }, []);

  const loadRepos = useCallback(async (): Promise<RepoEntry[]> => {
    const res = await fetch('/api/repos');
    if (!res.ok) throw new Error(`Failed to load repos: ${res.status}`);
    return (await res.json()) as RepoEntry[];
  }, []);

  const createFeature = useCallback(
    async (name: string, requirement: string, repos: string[]): Promise<FeatureSummary> => {
      const res = await fetch('/api/features', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, requirement, repos }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Create failed: ${res.status}`);
      }
      const feature = (await res.json()) as FeatureSummary;
      await refreshFeatures();
      window.history.pushState({}, '', `/features/${feature.id}`);
      setSelectedId(feature.id);
      return feature;
    },
    [refreshFeatures],
  );

  return { features, selectedId, selectFeature, createFeature, loadRepos, refreshFeatures, loading, error };
}
