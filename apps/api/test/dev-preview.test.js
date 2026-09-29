import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  externalPreviewUrl, extractPortHint, isDevServerCommand, isPreviewablePort,
  preferredPreviewPort, previewAuthorizationExpiresAt, previewDisplayPath,
  refreshPreviewAuthorization, requiresExternalPreview, resolvePreviewInput, usablePreviews,
} from '../../web/src/ui/preview.ts';
import { codespacesPreviewUrl } from '../src/codespaces-preview.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const webSrc = path.join(root, 'apps/web/src');
const app = () => fs.readFileSync(path.join(webSrc, 'ProductionApp.tsx'), 'utf8');
const css = () => fs.readFileSync(path.join(webSrc, 'styles.css'), 'utf8');
const pane = () => fs.readFileSync(path.join(webSrc, 'ui/preview-pane.tsx'), 'utf8');

const BASE = 'https://preview.example.work/';

describe('Codespaces preview URL fallback', () => {
  it('builds the browser URL from the persisted Codespace identity', () => {
    const previous = process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN;
    delete process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN;
    try {
      assert.equal(
        codespacesPreviewUrl({ codespaceName: 'fictional-space-abc123' }, 5173),
        'https://fictional-space-abc123-5173.app.github.dev/',
      );
      assert.equal(codespacesPreviewUrl({ codespaceName: 'fictional-space-abc123' }, 4173), 'https://fictional-space-abc123-4173.app.github.dev/');
      assert.equal(codespacesPreviewUrl({ codespaceName: 'fictional-space-abc123' }, 0), undefined);
      assert.equal(codespacesPreviewUrl({ codespaceName: undefined }, 5173), undefined);
    } finally {
      if (previous === undefined) delete process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN;
      else process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN = previous;
    }
  });

  it('supports an explicit forwarding-domain override without accepting paths', () => {
    const previous = process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN;
    try {
      process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN = 'https://preview.example.test/';
      assert.equal(
        codespacesPreviewUrl({ codespaceName: 'fictional-space-abc123' }, 3000),
        'https://fictional-space-abc123-3000.preview.example.test/',
      );
      process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN = 'https://preview.example.test/not-a-host';
      assert.equal(
        codespacesPreviewUrl({ codespaceName: 'fictional-space-abc123' }, 3000),
        'https://fictional-space-abc123-3000.preview.example.test/',
      );
    } finally {
      if (previous === undefined) delete process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN;
      else process.env.ORLYNX_CODESPACES_PORT_FORWARDING_DOMAIN = previous;
    }
  });
});

describe('dev-server intent and port truth (§§193, 205, 207, 214-215)', () => {
  it('TEST 1/8: detects start commands without assuming vite/5173', () => {
    for (const cmd of ['npm run dev', 'npm start', 'pnpm dev', 'yarn dev', 'vite', 'next dev', 'python3 -m http.server 8000', 'npx serve dist']) {
      assert.equal(isDevServerCommand(cmd), true, cmd);
    }
    for (const cmd of ['npm run build', 'npm test', 'tsc --noEmit', 'git status', 'npm run lint', 'jest src']) {
      assert.equal(isDevServerCommand(cmd), false, cmd);
    }
  });

  it('sniffs explicit ports from command or output instead of guessing', () => {
    assert.equal(extractPortHint('npm run dev -- --port 3001'), 3001);
    assert.equal(extractPortHint('Local: http://localhost:4173/'), 4173);
    assert.equal(extractPortHint('Serving on port 8000'), 8000);
    assert.equal(extractPortHint('npm run build'), undefined);
  });

  it('TEST 6/7: filters infra ports, keeps URLs, dedupes repeated detection', () => {
    const ports = [
      { port: 5173, url: `${BASE}5173/` },
      { port: 22, url: `${BASE}22/` },
      { port: 2222, url: `${BASE}2222/` },
      { port: 5432, url: `${BASE}5432/` },
      { port: 5173, url: `${BASE}5173/` },
      { port: 3000 },
    ];
    const usable = usablePreviews(ports);
    assert.deepEqual(usable.map((p) => p.port), [5173]);
    assert.equal(isPreviewablePort(22), false);
    assert.equal(isPreviewablePort(2222), false);
    assert.equal(isPreviewablePort(5173), true);
  });

  it('bridge and API require an application port rather than any listening socket', () => {
    const bridge = fs.readFileSync(path.join(root, 'bridge/src/index.ts'), 'utf8');
    const routes = fs.readFileSync(path.join(root, 'apps/api/src/routes.ts'), 'utf8');
    const gateway = fs.readFileSync(path.join(root, 'apps/api/src/bridge-gateway.ts'), 'utf8');
    assert.match(bridge, /NON_PREVIEW_PORTS = new Set\(\[22, 23, 25, 2222/);
    assert.match(bridge, /async function httpPreviewReady\(port: number\)/);
    assert.match(bridge, /await httpPreviewReady\(port\)/);
    assert.match(bridge, /port === servicePort/);
    assert.match(bridge, /loopbackOnly/);
    assert.match(bridge, /\|\| loopbackOnly/);
    assert.match(bridge, /gh', \[\s*'codespace', 'ports'/);
    assert.match(bridge, /--json', 'sourcePort,browseUrl,visibility'/);
    assert.match(routes, /blockedPreviewPorts = new Set\(\[22, 23, 25, 2222/);
    assert.match(gateway, /type: 'preview\.ready'/);
    assert.match(gateway, /verified: true/);
  });

  it('Codespaces Preview uses only confirmed GitHub forwarding metadata', () => {
    const bridge = fs.readFileSync(path.join(root, 'bridge/src/index.ts'), 'utf8');
    const provider = fs.readFileSync(path.join(root, 'apps/api/src/github-codespaces.ts'), 'utf8');
    const gateway = fs.readFileSync(path.join(root, 'apps/api/src/bridge-gateway.ts'), 'utf8');

    assert.match(bridge, /ghSupportsLoopbackPortForwarding/);
    assert.match(bridge, /major === 2 && minor >= 98/);
    assert.match(bridge, /'codespace', 'ports', 'forward'/);
    assert.match(bridge, /\`\$\{port\}:0\`/);
    assert.doesNotMatch(bridge, /--all-interfaces/);
    assert.match(bridge, /url: metadata\?\.browseUrl/);
    assert.match(bridge, /loopbackOnly/);
    assert.match(bridge, /codespacePortsPending\) return codespacePortsPending/);

    assert.doesNotMatch(provider, /codespacesPreviewUrl/);
    assert.match(provider, /never fabricate one from the Codespace name/);
    assert.match(provider, /return undefined/);

    assert.match(gateway, /type: 'preview\.state'/);
    assert.match(gateway, /localReady: true/);
    assert.match(gateway, /waiting for the workspace provider to expose a browser preview/);
    assert.match(gateway, /if \(!url\)/);
  });

  it('prefers likely frontends but never invents a URL', () => {
    assert.equal(preferredPreviewPort([])?.port ?? null, null);
    assert.equal(preferredPreviewPort([{ port: 8000, url: 'u8000' }, { port: 5173, url: 'u5173' }])?.port, 5173);
    assert.equal(preferredPreviewPort([{ port: 8000, url: 'u8000' }], 8000)?.port, 8000);
    assert.equal(preferredPreviewPort([{ port: 8000, url: 'u8000' }], 9999)?.port, 8000);
  });
});

describe('preview URL safety (§§192, 198-200, 222)', () => {
  it('never hands raw phone-localhost to the user; uses resolved URLs opaquely', () => {
    const src = pane();
    assert.doesNotMatch(src, /http:\/\/localhost/);
    assert.match(src, /sandbox="allow-scripts allow-same-origin allow-forms allow-popups"/);
    assert.match(app(), /if \(!found\?\.url\) return;/);
  });

  it('relative paths stay in-preview; foreign URLs go external', () => {
    assert.deepEqual(resolvePreviewInput(BASE, '/login'), { kind: 'preview', url: 'https://preview.example.work/login' });
    assert.deepEqual(resolvePreviewInput(BASE, 'dashboard'), { kind: 'preview', url: 'https://preview.example.work/dashboard' });
    const same = resolvePreviewInput(BASE, 'https://preview.example.work/a?b=1');
    assert.equal(same.kind, 'preview');
    assert.deepEqual(resolvePreviewInput(BASE, 'https://evil.example/'), { kind: 'external', url: 'https://evil.example/' });
    assert.deepEqual(resolvePreviewInput(BASE, ''), { kind: 'invalid' });
    assert.deepEqual(resolvePreviewInput(BASE, 'javascript:alert(1)'), { kind: 'invalid' });
  });

  it('warm-runner signed gateways keep their path, token and app route', () => {
    const gateway = 'https://runner.example/preview/orlynx-ws-demo/5173/?t=2000000000.old';
    const opened = resolvePreviewInput(gateway, '/login?next=home');
    assert.equal(opened.kind, 'preview');
    const openedUrl = new URL(opened.url);
    assert.equal(openedUrl.pathname, '/preview/orlynx-ws-demo/5173/login');
    assert.equal(openedUrl.searchParams.get('t'), '2000000000.old');
    assert.equal(openedUrl.searchParams.get('next'), 'home');
    assert.equal(previewDisplayPath(gateway, opened.url), '/login?next=home');

    const fresh = 'https://runner.example/preview/orlynx-ws-demo/5173/?t=2000000600.new';
    const renewed = refreshPreviewAuthorization(fresh, opened.url);
    assert.ok(renewed);
    const renewedUrl = new URL(renewed);
    assert.equal(renewedUrl.pathname, '/preview/orlynx-ws-demo/5173/login');
    assert.equal(renewedUrl.searchParams.get('t'), '2000000600.new');
    assert.equal(renewedUrl.searchParams.get('next'), 'home');
    assert.equal(previewAuthorizationExpiresAt(renewed), 2000000600 * 1000);
  });

  it('private Codespaces previews use secure external open instead of a blank iframe', () => {
    const privateCodespace = {
      port: 5173,
      visibility: 'private',
      url: 'https://example-space-5173.app.github.dev/',
    };
    const publicCodespace = { ...privateCodespace, visibility: 'public' };
    assert.equal(requiresExternalPreview(privateCodespace), true);
    assert.equal(requiresExternalPreview(publicCodespace), false);
    assert.equal(requiresExternalPreview({ port: 5173, visibility: 'private', url: 'https://runner.example/preview/x/5173/' }), false);

    const src = pane();
    assert.match(src, /GitHub keeps this Codespaces preview private/);
    assert.match(src, /Open secure preview/);
    assert.match(src, /!externalOnly && props\.currentUrl/);
    assert.match(src, /requiresExternalPreview\(match\) \? onOpenExternal/);
  });

  it('TEST 12/13: external open preserves the current same-origin path', () => {
    assert.equal(externalPreviewUrl(BASE, 'https://preview.example.work/dashboard'), 'https://preview.example.work/dashboard');
    assert.equal(externalPreviewUrl(BASE, 'https://other.example/x'), BASE);
    assert.match(app(), /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
    assert.match(pane(), /aria-label="Open preview in browser"/);
  });
});

describe('chat ↔ preview connection (§§190-191, 194, 202, 209-210, 216, 238)', () => {
  it('TEST 2/11: View preview exists only with a resolved URL', () => {
    assert.match(pane(), /className="server-preview-cta"[\s\S]*?requiresExternalPreview\(match\) \? onOpenExternal\(match\.url!\) : onViewPreview\(match\.port\)/);
    assert.match(pane(), /if \(!match\) \{[\s\S]*?return null/);
    assert.match(pane(), /activityState === 'failed'[\s\S]*?return null/);
  });

  it('startup stays one coherent activity with expandable detail, not five cards', () => {
    const src = pane();
    assert.doesNotMatch(src, /port detected|workspace port|health check/i);
    assert.match(src, /Development server started/);
    // Preview actions attach to the typed work part that owns the command.
    assert.match(app(), /<ServerPreviewAction command=\{[^}]*\} output=\{part\.item\.rawOutput\} isPreview=\{part\.kind === 'preview'\}/);
    assert.match(pane(), /if \(!isPreview && !isDevServerCommand\(command\)\) return null/);
  });

  it('TEST 3/4/16: chat action selects the tab, port and URL deterministically', () => {
    const src = app();
    assert.match(src, /const openPreview = useCallback\(\(port: number, path = '\/'\) => \{/);
    assert.match(src, /setTab\('preview'\)/);
    assert.match(src, /setPreviewPortSel\(port\)/);
    assert.match(src, /setPreviewStatus\('loading'\)/);
    assert.match(src, /previewAuthorizationExpiresAt\(currentPreviewUrl\)/);
    assert.match(src, /refreshPreviewAuthorization\(freshBase, currentPreviewUrl\)/);
  });

  it('TEST 9/10/20: stopped and failed states never claim readiness', () => {
    const src = pane();
    assert.match(src, /activityState === 'failed'[\s\S]*?return null/);
    assert.match(src, /Starting application…/);
    assert.match(app(), /setPreviewPorts\(\[\]\)/);
  });

  it('TEST 17: session switch resets preview context', () => {
    assert.match(app(), /setPreviewPorts\(\[\]\); setPreviewPortSel\(null\); setPreviewStack\(\[\]\); setPreviewIdx\(-1\);/);
    assert.match(app(), /setPreviewStatus\('idle'\); setPreviewSlow\(false\); setExternalSuggest\(null\)/);
  });

  it('TEST 15: chat derives from the same ports list as the tab', () => {
    const src = app();
    assert.match(src, /const usablePorts = useMemo\(\(\) => usablePreviews\(previewPorts\), \[previewPorts\]\)/);
    assert.match(src, /ports=\{previewPorts\} onViewPreview/);
    assert.match(src, /ports=\{usablePorts\} selected=\{selectedPreview\}/);
  });

  it('active Build work uses fast port reconciliation so Preview appears without a 10s lag', () => {
    const src = app();
    assert.match(src, /workspaceRunActive = runs\.some/);
    assert.match(src, /workspaceRunActive \? 1_000 : tab === 'preview' \? 2_500 : 10_000/);
    assert.match(src, /\[session\?\.id, integration\.workspace\?\.previewAvailable, online, refreshPorts, runs, tab\]/);
  });

  it('TEST 8: opening the same preview preserves navigation context', () => {
    assert.match(app(), /if \(port === previewPortSel && previewStack\.length\) \{ setTab\('preview'\); return; \}/);
  });

  it('stale selected ports cannot drift from the iframe/server truth', () => {
    const src = app();
    assert.match(src, /previewPortSel !== null[\s\S]*?usablePorts\.find/);
    assert.match(src, /if \(previewPortSel === null \|\| usablePorts\.some/);
    assert.match(src, /setPreviewPortSel\(null\); setPreviewStack\(\[\]\); setPreviewIdx\(-1\)/);
    assert.match(src, /setPreviewStack\(\[replacement\.url\]\); setPreviewIdx\(0\)/);
  });
});

describe('preview surface (§§196-197, 206, 211-213, 219-221, 232, 234)', () => {
  it('one canonical toolbar: back/forward/reload/path/external', () => {
    const src = pane();
    assert.match(src, /aria-label="Preview back"/);
    assert.match(src, /aria-label="Preview forward"/);
    assert.match(src, /aria-label="Reload preview"/);
    assert.match(src, /aria-label="Preview path"/);
    assert.match(src, /aria-label="Select running preview"/);
    assert.match(src, /<iframe[\s\S]*?onLoad=\{props\.onLoad\}[\s\S]*?onError=\{props\.onFrameError\}/);
    assert.doesNotMatch(src, /location\.reload|window\.location\.reload/);
  });

  it('loading, slow, blocked and unreachable states stay distinct', () => {
    const src = pane();
    assert.match(src, /Loading preview…/);
    assert.match(src, /Still waiting for the development server…/);
    assert.match(src, /This preview can’t be embedded here\./);
    assert.match(src, /Preview couldn’t load\./);
    assert.match(src, /View server output/);
  });

  it('TEST 19: embed failure falls back to external open, never a dead frame', () => {
    assert.match(pane(), /status !== 'blocked' && \(\s*<iframe/);
    assert.match(app(), /onFrameError=\{\(\) => setPreviewStatus\('blocked'\)\}/);
  });

  it('TEST 18/232: tab badge, mobile spacing and touch targets', () => {
    assert.match(app(), /`Preview\$\{usablePorts\.length \? ' ●' : ''\}`/);
    const source = css();
    assert.match(source, /\.preview-pane \{[\s\S]*?padding-bottom: 120px/);
    assert.match(source, /\.preview-pane \{[\s\S]*?padding-bottom: 190px/);
    assert.match(source, /\.preview-tool \{[\s\S]*?min-width: 40px;\s*min-height: 40px;/);
    assert.match(source, /\.preview-address input \{[\s\S]*?min-height: 40px;/);
    assert.match(source, /\.server-preview-cta \{[\s\S]*?min-height: 40px;/);
  });

  it('TEST 5/14: reload targets the preview frame only', () => {
    assert.match(app(), /onReload=\{\(\) => \{ setPreviewStatus\('loading'\); setPreviewSlow\(false\); setPreviewReloadKey\(\(k\) => k \+ 1\); \}\}/);
    assert.match(pane(), /key=\{props\.reloadKey\}/);
  });

  it('TEST 16b: back/forward walk Orlynx-tracked history, not the host app', () => {
    const src = app();
    assert.match(src, /setPreviewIdx\(\(i\) => Math\.max\(0, i - 1\)\)/);
    assert.match(src, /setPreviewIdx\(\(i\) => Math\.min\(previewStack\.length - 1, i \+ 1\)\)/);
    assert.match(src, /canBack=\{previewIdx > 0\} canForward=\{previewIdx < previewStack\.length - 1\}/);
  });
});
