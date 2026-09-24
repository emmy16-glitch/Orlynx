export const API = (p: string) => (import.meta.env.DEV ? p : p);

export async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string; code?: string; diagnostic?: string };
    const error = new Error(body.error || r.statusText) as Error & { code?: string; diagnostic?: string; status?: number };
    error.code = body.code;
    error.diagnostic = body.diagnostic;
    error.status = r.status;
    throw error;
  }
  return r.json() as Promise<T>;
}
