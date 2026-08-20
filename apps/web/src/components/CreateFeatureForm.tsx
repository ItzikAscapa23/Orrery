import { useEffect, useState } from 'react';
import type { useFeature, RepoEntry } from '../hooks/useFeature.js';

interface CreateFeatureFormProps {
  onCreate: ReturnType<typeof useFeature>['createFeature'];
  loadRepos: ReturnType<typeof useFeature>['loadRepos'];
}

export function CreateFeatureForm({ onCreate, loadRepos }: CreateFeatureFormProps) {
  const [name, setName] = useState('');
  const [requirement, setRequirement] = useState('');
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [availableRepos, setAvailableRepos] = useState<RepoEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadRepos().then(setAvailableRepos).catch(() => {
      // non-fatal: form still renders without the repo list
    });
  }, [loadRepos]);

  function toggleRepo(id: string) {
    setSelectedRepos((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !requirement.trim() || selectedRepos.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      await onCreate(name.trim(), requirement.trim(), selectedRepos);
      setName('');
      setRequirement('');
      setSelectedRepos([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid var(--border-medium)',
    borderRadius: 'var(--r-input)',
    fontSize: 12,
    color: 'var(--text-primary)',
    marginBottom: 8,
    fontFamily: 'var(--font-ui)',
  };

  const isSubmitDisabled = loading || !name.trim() || !requirement.trim() || selectedRepos.length === 0;

  return (
    <form onSubmit={(e) => void handleSubmit(e)} style={{ padding: '16px' }}>
      <div
        className="mono-tag"
        style={{
          color: 'var(--text-muted)',
          marginBottom: 12,
          display: 'block',
          letterSpacing: '0.13em',
        }}
      >
        New Feature
      </div>
      <input
        placeholder="Feature name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={fieldStyle}
        disabled={loading}
      />
      <textarea
        placeholder="Business requirement…"
        value={requirement}
        onChange={(e) => setRequirement(e.target.value)}
        rows={3}
        style={{ ...fieldStyle, resize: 'vertical' }}
        disabled={loading}
      />
      {availableRepos.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-muted)',
              letterSpacing: '0.1em',
              marginBottom: 6,
              textTransform: 'uppercase',
            }}
          >
            Repos
          </div>
          {availableRepos.map((repo) => (
            <label
              key={repo.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                marginBottom: 6,
                cursor: loading ? 'default' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={selectedRepos.includes(repo.id)}
                onChange={() => toggleRepo(repo.id)}
                disabled={loading}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                <span style={{ color: 'var(--text-primary)' }}>{repo.id}</span>
                <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 10 }}>
                  {repo.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      {error && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: '#ff5b45',
            marginBottom: 8,
          }}
        >
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={isSubmitDisabled}
        style={{
          width: '100%',
          padding: '9px',
          borderRadius: 'var(--r-btn)',
          background: '#ff5b45',
          color: '#fff',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          opacity: isSubmitDisabled ? 0.6 : 1,
        }}
      >
        {loading ? 'Creating…' : 'Create Feature'}
      </button>
    </form>
  );
}
