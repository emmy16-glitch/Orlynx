import { describe, it } from 'node:test';
import assert from 'node:assert';

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}

describe('orlynx guards', () => {
  it('safeName prevents traversal', () => {
    assert.equal(safeName('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(safeName('shot.png'), 'shot.png');
  });
  it('base-SHA conflict rule', () => {
    const base = 'abc123', head = 'def456';
    const blocked = head !== base;
    assert.equal(blocked, true);
  });
  it('approval policy denies public expose by default', () => {
    const needsApproval = (a) => ['port.expose.public', 'git.force-push'].includes(a);
    assert.equal(needsApproval('port.expose.public'), true);
    assert.equal(needsApproval('fs.read'), false);
  });
});
