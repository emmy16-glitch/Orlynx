import { createHash } from 'node:crypto';
import type { KnowledgeEdgeRecord } from './storage.js';

export function knowledgeAffected(edge: Pick<KnowledgeEdgeRecord, 'referencedFiles'>, changedFiles: string[]): boolean {
  const files = new Set(changedFiles);
  return edge.referencedFiles.some(file => files.has(file));
}
export function verifiedKnowledgeEdge(input: Omit<KnowledgeEdgeRecord, 'id' | 'confidence' | 'status' | 'firstObservedAt' | 'lastVerifiedAt'>, verified: boolean): KnowledgeEdgeRecord | undefined {
  if (!verified || !/^[a-f0-9]{40}$/i.test(input.commitSha) || !input.evidenceRefs.length || !input.referencedFiles.length) return undefined;
  const id = `edge_${createHash('sha256').update([input.userId,input.projectId,input.subject,input.predicate,input.object].join('\0')).digest('hex').slice(0,24)}`;
  const now = new Date().toISOString();
  return { ...input, id, confidence: 0.7, status: 'active', firstObservedAt: now, lastVerifiedAt: now };
}

/** Only independently revalidated, scoped facts enter execution context. */
export async function repositoryKnowledgeInstruction(session: {userId: string; projectId: string; workspaceId: string | null}, prompt: string): Promise<string> {
  if (!session.workspaceId) return '';
  const { controlPlaneRepository } = await import('./storage.js');
  const { bridgeRequest } = await import('./bridge-rpc.js');
  const { redactEventString } = await import('./events.js');
  const repository=controlPlaneRepository();
  const terms=prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter(word=>word.length>2);
  const edges=(await repository.listKnowledgeEdges(session.userId,session.projectId)).filter(edge=>edge.status==='active' && edge.confidence>=0.5)
    .sort((a,b)=>terms.filter(term=>`${b.subject} ${b.object}`.toLowerCase().includes(term)).length-terms.filter(term=>`${a.subject} ${a.object}`.toLowerCase().includes(term)).length).slice(0,12);
  const validated=await Promise.all(edges.map(async edge=>{
    try {
      const result=await bridgeRequest<{changedFiles: string[]; missingFiles: string[]}>(session.workspaceId!, 'knowledge.provenance', {commitSha:edge.commitSha,files:edge.referencedFiles},10000);
      const changed=[...result.changedFiles,...result.missingFiles];
      await repository.invalidateKnowledgeEdges(session.userId,session.projectId,changed,edge.commitSha);
      if (knowledgeAffected(edge,changed)) return undefined;
      return edge;
    } catch { return undefined; }
  }));
  const facts=validated.filter((edge): edge is KnowledgeEdgeRecord=>Boolean(edge));
  if (!facts.length) return '';
  return ['Orlynx repository knowledge, rechecked against the current workspace. Fresh observations override these facts.',...facts.map(edge=>redactEventString(`${edge.subject} ${edge.predicate} ${edge.object} [commit ${edge.commitSha}; evidence ${edge.evidenceRefs.slice(0,2).join(', ')}]`).slice(0,600))].join('\n');
}
