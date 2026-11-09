export type LiveResource = 'jobs' | 'workers' | 'stats';

export type LiveEventName = 'invalidate' | 'resync';

type LivePayload = {
  v: number;
  revision: number;
  resources: LiveResource[];
  at?: string;
};

const KNOWN: ReadonlySet<string> = new Set(['jobs', 'workers', 'stats']);

export function parseLivePayload(data: string): LiveResource[] | null {
  try {
    const parsed = JSON.parse(data) as LivePayload;
    if (!Array.isArray(parsed.resources)) return null;
    const out = parsed.resources.filter((r): r is LiveResource => KNOWN.has(r));
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
