import { assertLiveE2ESession } from './e2e-safety.js';
export const E2E_REPOSITORY = 'emmy16-glitch/Orlynx';
export function browserE2EPlan(now = Date.now()) {
  const branch = `orlynx-e2e/${now}`;
  assertLiveE2ESession(E2E_REPOSITORY, branch);
  return { branch, filename: `orlynx-e2e-${now}.txt`, clientId: `browser-e2e-${now}` };
}
export function verifyReplay(events: {sequence: number; eventId: string}[]) {
  if (!events.length) throw new Error('No durable events were persisted.');
  if (new Set(events.map(e => e.eventId)).size !== events.length || events.some((e,i) => !Number.isSafeInteger(e.sequence) || e.sequence <= (i ? events[i-1].sequence : 0))) throw new Error('Duplicate or out-of-order durable events.');
  return { count: events.length, lastSequence: events.at(-1)!.sequence };
}
