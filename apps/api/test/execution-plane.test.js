import test from 'node:test';
import assert from 'node:assert/strict';
import { executionPlaneFor } from '../src/direct-chat.ts';

test('plain conversation does not start a development environment', () => {
  assert.equal(executionPlaneFor('Hello', 'build'), 'direct');
  assert.equal(executionPlaneFor('What does this repository do?', 'build'), 'direct');
  assert.equal(executionPlaneFor('Explain the authentication flow', 'build'), 'direct');
  assert.equal(executionPlaneFor('Review this architecture and suggest improvements', 'ask'), 'direct');
});

test('runtime and mutating build work requests the development environment', () => {
  assert.equal(executionPlaneFor('Run the tests and fix what fails', 'build'), 'workspace');
  assert.equal(executionPlaneFor('npm install and start the dev server', 'build'), 'workspace');
  assert.equal(executionPlaneFor('Implement the login fix', 'build'), 'workspace');
  assert.equal(executionPlaneFor('Update the README file', 'build'), 'workspace');
});

test('plan and ask modes remain direct because they cannot mutate the project', () => {
  assert.equal(executionPlaneFor('Plan how to refactor the backend', 'plan'), 'direct');
  assert.equal(executionPlaneFor('Tell me how you would fix the build', 'ask'), 'direct');
});
