'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, message } from './client';
export function useResource<T>(path: string | null, poll = false) {
  const [data, setData] = useState<T>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(!!path);
  const [revision, setRevision] = useState(0); const generation = useRef(0);
  const reload = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    const gen = ++generation.current; const controller = new AbortController(); let alive = true;
    setData(undefined); setError(''); setLoading(!!path);
    async function load() {
      if (!path || !alive) return;
      try { const next = await api<T>(path, 'GET', undefined, controller.signal); if (alive && gen === generation.current) { setData(next); setError(''); } }
      catch (e) { if (alive && (e as Error).name !== 'AbortError') setError(message(e)); }
      finally { if (alive) setLoading(false); }
    }
    void load();
    const timer = poll ? setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 3000) : undefined;
    const visible = () => { if (poll && document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; controller.abort(); if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [path, revision, poll]);
  return { data, setData, error, loading, reload };
}
export function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const lock = useRef(false);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { return await action(); } catch (e) { setError(message(e)); return undefined; }
    finally { lock.current = false; setBusy(false); }
  }
  return { busy, error, setError, run };
}
