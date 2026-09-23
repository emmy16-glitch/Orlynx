export const API = (p: string) => (import.meta.env.DEV ? p : p);

export async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error || r.statusText);
  return r.json() as Promise<T>;
}
