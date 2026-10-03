import { randomUUID, createHash } from 'node:crypto';
import { controlPlaneRepository, type ProductionObservationRecord } from './storage.js';
import type { ProjectSession } from '@orlynx/shared';
import { renderDeployStatus } from './render.js';
import { emitPersisted } from './events.js';

function healthUrls(): string[] {
  return (process.env.ORLYNX_POST_DEPLOY_HEALTH_URLS || '').split(',').map(value => value.trim()).filter(value => /^https:\/\//.test(value)).slice(0,8);
}
export async function scheduleProductionObservation(session: ProjectSession & { userId: string; projectId: string }, commitSha: string): Promise<boolean> {
  if (!healthUrls().length) return false;
  const now=Date.now();
  const id=`obs_${createHash('sha256').update(`${session.userId}:${session.projectId}:${commitSha}`).digest('hex').slice(0,24)}`;
  await controlPlaneRepository().enqueueProductionObservation({ id,sessionId:session.id,userId:session.userId,projectId:session.projectId,commitSha,state:'pending',startedAt:new Date(now).toISOString(),observeUntil:new Date(now+Math.max(30000,Math.min(Number(process.env.ORLYNX_POST_DEPLOY_WINDOW_MS || 120000),600000))).toISOString(),samples:[] });
  return true;
}
export async function productionHealthSample(commitSha: string, urls: string[], fetcher: typeof fetch = fetch) {
  return Promise.all(urls.map(async url => {
    try {
      const response=await fetcher(url,{signal:AbortSignal.timeout(5000),redirect:'error'});
      const body=await response.json() as { commit?: string; buildCommit?: string; ready?: boolean; alive?: boolean; healthy?: boolean };
      const commitMatches=(body.commit || body.buildCommit)===commitSha;
      const healthy=response.ok && body.ready!==false && body.healthy!==false && body.alive!==false;
      return {url,status:response.status,healthy,commitMatches};
    } catch { return {url,healthy:false,commitMatches:false}; }
  }));
}
export async function runProductionObservationSweep(): Promise<void> {
  const repository=controlPlaneRepository();
  const owner=randomUUID();
  const observations=await repository.claimProductionObservations(owner);
  await Promise.all(observations.map(async record => {
    const deployment=await renderDeployStatus(record.commitSha);
    const endpoints=await productionHealthSample(record.commitSha,healthUrls());
    const sample={at:new Date().toISOString(),healthy:endpoints.length>0 && endpoints.every(item=>item.healthy),commitMatches:deployment.live===true && deployment.commitMatches===true && endpoints.every(item=>item.commitMatches),endpoints};
    record.samples=[...record.samples,sample].slice(-30);
    if (!sample.healthy || !sample.commitMatches) record.state=deployment.configured ? 'regressed' : 'unknown';
    else if (Date.now()>=Date.parse(record.observeUntil) && record.samples.length>=2) record.state='healthy';
    if (record.state==='pending') { await repository.completeProductionObservation(record,owner); return; }
    // Persist idempotent learning before acknowledging the terminal observation.
    // A crash repeats this source commit instead of dropping the learning action.
    const session=await repository.getSession(record.sessionId);
    if (!session || session.userId!==record.userId || session.projectId!==record.projectId) return;
    if(record.state==='healthy') {
      const {rememberVerifiedProductionOutcome}=await import('./agent-memory.js');
      await rememberVerifiedProductionOutcome({session,commitSha:record.commitSha,deployment,provider:'render',observationVerified:true});
    } else if(record.state==='regressed') {
      const lessons=await repository.listAgentLessons(record.userId,record.projectId,100);
      await repository.invalidateAgentLessons(record.userId,record.projectId,lessons.filter(lesson=>lesson.repositoryCommit===record.commitSha && lesson.kind==='deployment_procedure').map(lesson=>lesson.id),'Exact-commit production observation failed.');
    }
    const accepted=await repository.completeProductionObservation(record,owner);
    if (accepted) await emitPersisted(record.sessionId,'state.delta',{scope:'production-observation',observationId:record.id,commitSha:record.commitSha,state:record.state,samples:record.samples});
  }));
}
