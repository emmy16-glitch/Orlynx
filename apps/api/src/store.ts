import fs from 'node:fs';
import path from 'node:path';
import type { AttachmentMeta, AgentRun, ChangeSet, ChatMessage, OrlynxEvent, ProjectSession } from '@orlynx/shared';

const DATA_DIR = process.env.ORLYNX_DATA_DIR || path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'orlynx.json');

export interface GitHubInstallationRecord {
  id: number;
  account: string;
  accountType: string;
  installedAt: string;
  status?: 'active' | 'suspended';
  connectedAt?: string;
  updatedAt?: string;
  lastVerifiedAt?: string;
}

interface DB {
  sessions: Record<string, ProjectSession>;
  messages: Record<string, ChatMessage[]>;
  events: Record<string, OrlynxEvent[]>;
  attachments: Record<string, AttachmentMeta[]>;
  changes: Record<string, ChangeSet[]>;
  runs: Record<string, AgentRun[]>;
  seq: Record<string, number>;
  githubInstallations: GitHubInstallationRecord[];
  openCodeSessions: Record<string, string>;
}

function blank(): DB {
  return { sessions: {}, messages: {}, events: {}, attachments: {}, changes: {}, runs: {}, seq: {}, githubInstallations: [], openCodeSessions: {} };
}

export class Store {
  db: DB;
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'attachments'), { recursive: true });
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        this.db = { ...blank(), ...raw };
        // Migrate pre-status installation rows to the current shape.
        const now = new Date().toISOString();
        this.db.githubInstallations = (this.db.githubInstallations || []).map((item) => ({
          status: 'active' as const,
          connectedAt: item.installedAt,
          updatedAt: item.updatedAt || item.installedAt || now,
          ...item,
        }));
      } else {
        this.db = blank();
      }
    } catch {
      this.db = blank();
    }
  }
  save() {
    fs.writeFileSync(DB_FILE, JSON.stringify(this.db, null, 2));
  }
  nextSeq(sessionId: string): number {
    const n = (this.db.seq[sessionId] || 0) + 1;
    this.db.seq[sessionId] = n;
    return n;
  }
}

export const store = new Store();
export const dataDir = DATA_DIR;
