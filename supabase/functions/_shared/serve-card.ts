import { createCardHandler } from './card-api.ts';

export function serveCard(action: 'lookup' | 'redeem') {
  const url = Deno.env.get('SUPABASE_URL');
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  const secret = keys ? JSON.parse(keys).default : undefined;
  const legacyKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const serviceKey: string | undefined = secret ?? legacyKey;
  if (!url || !serviceKey) throw new Error('Supabase backend configuration is missing.');

  const headers = new Headers({ apikey: serviceKey, 'Content-Type': 'application/json' });
  if (!secret) headers.set('Authorization', 'Bearer ' + serviceKey);

  const handler = createCardHandler(action, Deno.env.get('DRINK_PASS_QR_SECRET') ?? '', async (name, params) => {
    const response = await fetch(new URL('/rest/v1/rpc/' + name, url), {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Card database request failed.');
    return await response.json();
  });
  Deno.serve(handler);
}
