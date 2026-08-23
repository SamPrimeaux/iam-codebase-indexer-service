/** Portable copy — SSOT: inneranimalmedia/backend/auth/bridge-key-auth.js */

function trim(v) {
  return v == null ? '' : String(v).trim();
}

export function configuredMachineAuthSecrets(env) {
  const key = trim(env?.AGENTSAM_BRIDGE_KEY);
  return key ? [key] : [];
}

export function presentedMachineAuthCredentials(request) {
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const vals = [
    bearer,
    request.headers.get('X-Internal-Secret'),
    request.headers.get('X-Ingest-Secret'),
    request.headers.get('X-IAM-Service-Key'),
    request.headers.get('X-ExecOS-Key'),
  ]
    .map(trim)
    .filter(Boolean);
  return [...new Set(vals)];
}

export function verifyBridgeKey(request, env) {
  const expected = configuredMachineAuthSecrets(env);
  if (!expected.length) return false;
  const presented = presentedMachineAuthCredentials(request);
  if (!presented.length) return false;
  return presented.some((p) => expected.includes(p));
}
