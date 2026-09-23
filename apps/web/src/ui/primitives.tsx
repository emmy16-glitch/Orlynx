// Level 1 — Primitives. Accessible, token-driven, copy-and-own (no UI lib dependency).
import React from 'react';
import './components.css';

type Tone = 'ok' | 'work' | 'wait' | 'fail' | 'neutral';

export function Button({ tone = 'primary', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' }) {
  const cls = tone === 'primary' ? 'ox-btn ox-btn-primary' : tone === 'danger' ? 'ox-btn ox-btn-danger' : 'ox-btn ox-btn-ghost';
  return <button {...p} className={`${cls} ${p.className || ''}`} />;
}

export function IconButton(p: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const { label, ...rest } = p;
  return <button aria-label={label} title={label} {...rest} className={`ox-iconbtn ${p.className || ''}`} />;
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className="ox-badge" data-tone={tone === 'neutral' ? undefined : tone}><span className="dot" aria-hidden />{children}</span>;
}

export function Card(p: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={`ox-card ${p.className || ''}`} />;
}

export function Input(p: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={`ox-input ${p.className || ''}`} />;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span role="status" aria-label={label} className="ox-spinner" />;
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div aria-hidden>{Array.from({ length: lines }).map((_, i) => <div key={i} className="ox-skel" style={{ margin: '6px 0' }} />)}</div>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return <div className="ox-card" role="status"><b>{title}</b>{hint && <div className="small">{hint}</div>}</div>;
}

export function ErrorState({ title, hint, onRetry }: { title: string; hint?: string; onRetry?: () => void }) {
  return (
    <div className="ox-card" role="alert">
      <b>{title}</b>
      {hint && <div className="small">{hint}</div>}
      {onRetry && <div className="ox-row" style={{ marginTop: 8 }}><Button tone="ghost" onClick={onRetry}>Retry</Button></div>}
    </div>
  );
}

// Single coherent inline icon family (no icon lib = zero weight, consistent stroke).
export type IconName = 'check' | 'dot' | 'ring' | 'x' | 'pause' | 'plus' | 'cloud' | 'file' | 'warn' | 'home' | 'folder' | 'settings' | 'agents' | 'search' | 'chevron' | 'github' | 'branch' | 'more' | 'terminal' | 'preview' | 'arrow' | 'paperclip' | 'send' | 'clock' | 'external' | 'menu' | 'commit' | 'shield' | 'monitor' | 'refresh' | 'camera' | 'link' | 'inbox' | 'code' | 'repo' | 'close' | 'upload';

// One Orlynx-owned 16px outline set: consistent dimensions, 1.7px stroke, no icon dependency.
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  const paths: Record<IconName, React.ReactNode> = {
    check: <path d="m5 12 4 4L19 6" />, dot: <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />, ring: <circle cx="12" cy="12" r="8" />,
    x: <path d="m6 6 12 12M18 6 6 18" />, close: <path d="m6 6 12 12M18 6 6 18" />, warn: <><path d="M12 3 2.8 20h18.4z" /><path d="M12 9v4M12 16h.01" /></>, pause: <path d="M9 5v14M15 5v14" />,
    plus: <path d="M12 5v14M5 12h14" />, cloud: <path d="M7 18a4 4 0 0 1-.4-8A6 6 0 0 1 18 11a3.5 3.5 0 0 1-.5 7z" />,
    file: <path d="M13 3H6v18h12V8zM13 3v5h5" />, home: <path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7" />,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.3 1-1.3 2.2-1.6-.6a8 8 0 0 1-1.5.9l-.3 1.7h-2.6l-.3-1.7a8 8 0 0 1-1.5-.9l-1.6.6-1.3-2.2 1.3-1a7 7 0 0 1 0-1.8l-1.3-1 1.3-2.2 1.6.6a8 8 0 0 1 1.5-.9l.3-1.7h2.6l.3 1.7a8 8 0 0 1 1.5.9l1.6-.6 1.3 2.2-1.3 1a7 7 0 0 1-.1 1.7Z" transform="translate(-1 -1)" /></>,
    agents: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M17 8h4M19 6v4M17 15h4M18 18h3" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>, chevron: <path d="m9 18 6-6-6-6" />,
    github: <><path d="M9 19c-4.5 1.4-4.5-2.5-6.3-3M15 21v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.1-1.5 6.1-6.7a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.2-.4-4 1.5a13.8 13.8 0 0 0-7.3 0C4.3.2 3.1.6 3.1.6A4.8 4.8 0 0 0 3 4.2a5.2 5.2 0 0 0-1.4 3.6c0 5.2 3.1 6.4 6.1 6.7a3.4 3.4 0 0 0-.9 2.6V21" transform="translate(2 1) scale(.82)" /></>,
    branch: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><path d="M6 8v8M18 8a6 6 0 0 1-6 6H8" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
    terminal: <><path d="m4 7 5 5-5 5M12 17h8" /></>, preview: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 6.5h.01M5.5 6.5h.01" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>, paperclip: <path d="m8 12.5 7.8-7.8a3.5 3.5 0 0 1 5 5l-9.2 9.2a5 5 0 0 1-7.1-7.1l9.2-9.2" />,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>, clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />, commit: <><circle cx="12" cy="12" r="8" /><path d="M2 12h6M16 12h6" /></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 9a7 7 0 0 1 11.6-2L20 12M4 12l2.9 5a7 7 0 0 0 11.6-2" /></>,
    camera: <><path d="M4 7h4l2-2h4l2 2h4v12H4z" /><circle cx="12" cy="13" r="3" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l3-3A5 5 0 0 0 13 2.9l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.7-1.7" /></>,
    inbox: <><path d="M4 4h16v16H4zM4 14h4l2 3h4l2-3h4" /></>, code: <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" /></>,
    repo: <><path d="M5 3h11l3 3v15H5zM16 3v4h4M8 11h8M8 15h8" /></>, upload: <><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}
