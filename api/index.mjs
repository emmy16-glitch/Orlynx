// Vercel serverless entry: control plane only (no OpenCode process,
// no PTY, no long-lived workers — those live in the workspace plane).
import { app } from '../apps/api/dist/app.js';

export default app;
