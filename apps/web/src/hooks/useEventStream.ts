import { useEffect, useRef, useState } from 'react';
import type { EventRow } from '@orrery/shared';

interface UseEventStreamResult {
  events: EventRow[];
  connected: boolean;
  error: string | null;
}

/**
 * Fetches the full event history for a feature, then opens an SSE connection
 * to receive live events. On reconnect, resumes from the last seen seq via
 * Last-Event-ID so no events are lost across page refreshes or reconnects.
 */
export function useEventStream(featureId: string | null): UseEventStreamResult {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSeqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!featureId) {
      setEvents([]);
      setConnected(false);
      setError(null);
      lastSeqRef.current = 0;
      return;
    }

    let cancelled = false;

    async function start() {
      // 1. Fetch full history
      try {
        const res = await fetch(`/api/features/${featureId}/events/history?limit=500`);
        if (!res.ok) throw new Error(`History fetch failed: ${res.status}`);
        const history = (await res.json()) as EventRow[];
        if (cancelled) return;
        setEvents(history);
        lastSeqRef.current = history.length > 0 ? Math.max(...history.map((e) => e.seq)) : 0;
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        return;
      }

      // 2. Open SSE tail from last seen seq
      function openSSE() {
        if (cancelled) return;
        const since = lastSeqRef.current;
        const url = `/api/features/${featureId}/events?since=${since}`;
        const es = new EventSource(url);
        esRef.current = es;

        es.onopen = () => {
          if (!cancelled) setConnected(true);
        };

        es.onmessage = (e: MessageEvent) => {
          if (cancelled) return;
          try {
            const row = JSON.parse(e.data as string) as EventRow;
            lastSeqRef.current = Math.max(lastSeqRef.current, row.seq);
            setEvents((prev) => [...prev, row]);
          } catch {
            // ignore malformed frames
          }
        };

        es.onerror = () => {
          if (cancelled) return;
          setConnected(false);
          es.close();
          // Reconnect after a short delay using Last-Event-ID semantics
          setTimeout(openSSE, 2000);
        };
      }

      openSSE();
    }

    void start();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [featureId]);

  return { events, connected, error };
}
