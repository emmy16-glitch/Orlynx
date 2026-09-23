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
export function Icon({ name }: { name: 'check' | 'dot' | 'ring' | 'x' | 'pause' | 'plus' | 'cloud' | 'file' | 'warn' }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true } as const;
  if (name === 'check') return <svg {...common}><path d="M3 8.5l3.2 3L13 4.5" /></svg>;
  if (name === 'x') return <svg {...common}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
  if (name === 'pause') return <svg {...common}><path d="M6 3v10M10 3v10" /></svg>;
  if (name === 'plus') return <svg {...common}><path d="M8 3v10M3 8h10" /></svg>;
  if (name === 'cloud') return <svg {...common}><path d="M4.5 12a2.5 2.5 0 01-.4-5A3.5 3.5 0 0111 8a2.2 2.2 0 01-.5 4z" /></svg>;
  if (name === 'file') return <svg {...common}><path d="M4 2h5l3 3v9H4zM9 2v3h3" /></svg>;
  if (name === 'warn') return <svg {...common}><path d="M8 2L2 13h12zM8 7v3M8 12v.5" /></svg>;
  if (name === 'ring') return <svg {...common}><circle cx="8" cy="8" r="5.5" /></svg>;
  return <svg {...common}><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" /></svg>;
}
