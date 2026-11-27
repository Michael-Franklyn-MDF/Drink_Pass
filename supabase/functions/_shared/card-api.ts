type Action = 'lookup' | 'redeem';
type Invoke = (name: string, params: Record<string, string | null>) => Promise<{ status: string }>;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidPattern = new RegExp('^' + UUID + '$', 'i');
const qrPattern = new RegExp('^(v1\\.(' + UUID + '))\\.([A-Za-z0-9_-]{43})$');
const deviceKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const text = new TextEncoder();

const statusCodes: Record<string, number> = {
  eligible: 200,
  accepted: 200,
  invalid_request: 400,
  unknown_device: 401,
  card_not_found: 404,
  card_voided: 410,
  invalid_signature: 422,
  no_drinks_left: 409,
  cooldown_active: 409,
  already_redeemed: 409,
  drink_unavailable: 409,
  request_conflict: 409,
};

function json(result: { status: string }, httpStatus: number): Response {
  return Response.json(result, { status: httpStatus, headers: { 'Cache-Control': 'no-store' } });
}

function signatureBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '=';
  const decoded = atob(base64);
  return btoa(decoded) === base64 ? Uint8Array.from(decoded, (char) => char.charCodeAt(0)) : null;
}

async function verifiedCard(qr: string, key: Promise<CryptoKey>): Promise<string | null> {
  const match = qrPattern.exec(qr);
  if (!match) return null;
  const [, signed, id, encoded] = match;
  const signature = signatureBytes(encoded);
  if (!signature) return null;
  return await crypto.subtle.verify('HMAC', await key, signature, text.encode(signed)) ? id : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export function createCardHandler(action: Action, signingSecret: string, invoke: Invoke) {
  if (!/^[0-9a-f]{64}$/i.test(signingSecret)) {
    throw new Error('DRINK_PASS_QR_SECRET must contain 32 bytes encoded as hex.');
  }
  const keyBytes = Uint8Array.from(signingSecret.match(/../g)!, (byte) => parseInt(byte, 16));
  const key = crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ status: 'method_not_allowed' }, 405);

    const deviceKey = request.headers.get('X-Drink-Pass-Device-Key');
    if (!deviceKey || !deviceKeyPattern.test(deviceKey)) return json({ status: 'unknown_device' }, 401);

    const body = await request.json().catch(() => null);
    if (!body || typeof body.qr !== 'string' || body.qr.length > 128) {
      return json({ status: 'invalid_request' }, 400);
    }
    if (action === 'redeem' && (!isUuid(body.drinkId) || !isUuid(body.requestId))) {
      return json({ status: 'invalid_request' }, 400);
    }

    try {
      const [card, hash] = await Promise.all([
        verifiedCard(body.qr, key),
        crypto.subtle.digest('SHA-256', text.encode(deviceKey)),
      ]);
      const params: Record<string, string | null> = {
        p_card: card,
        p_key_hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      };
      if (action === 'redeem') {
        params.p_drink = body.drinkId;
        params.p_request = body.requestId;
      }
      const result = await invoke('drink_pass_card_' + action, params);
      const httpStatus = Object.hasOwn(statusCodes, result.status) ? statusCodes[result.status] : undefined;
      if (httpStatus === undefined) throw new Error('Unexpected redemption outcome.');
      return json(result, httpStatus);
    } catch {
      return json({ status: 'service_unavailable' }, 503);
    }
  };
}
