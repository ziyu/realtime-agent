import { useEffect, useState } from 'react';
import type { WorldState } from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function sendApi<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(detail?.error ?? '请求失败，请稍后再试。', response.status);
  }
  return response.json() as Promise<T>;
}

export function useWorld() {
  const [world, setWorld] = useState<WorldState | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('state', event => {
      try { setWorld(JSON.parse(event.data) as WorldState); setConnected(true); }
      catch { setConnected(false); }
    });
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, []);
  return { world, connected };
}
