import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
// Never cache: .env edits should show up after a dev server restart.
export const dynamic = 'force-dynamic';

// Server-side keys (env-keys values and the AWS SigV4 fallback in /api/run)
// are only exposed when LPB_ENABLE_SERVER_KEYS=1 is set. Off by default so a
// public deployment never leaks keys or lets strangers spend server
// credentials; local development opts in via .env.
const serverKeysEnabled = process.env.LPB_ENABLE_SERVER_KEYS === '1';

// GET /api/env-keys — expose server-side env vars ending in _API_KEY so the
// UI can offer them as API key choices. Only non-empty values are returned,
// and only when server keys are enabled (local dev). For AWS Bedrock,
// exposes only a boolean flag (never the credentials): when true, the proxy
// signs with AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the server env,
// so the UI fields can stay blank.
export async function GET() {
  if (!serverKeysEnabled) {
    return NextResponse.json({ keys: [], awsConfigured: false });
  }
  const keys = Object.entries(process.env)
    .filter(([name, value]) => name.endsWith('_API_KEY') && value)
    .map(([name, value]) => ({ name, value: value as string }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const awsConfigured = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  return NextResponse.json({ keys, awsConfigured });
}
