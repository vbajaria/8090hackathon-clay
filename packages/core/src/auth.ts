import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {createServerClient, parseCookieHeader, serializeCookieHeader} from '@supabase/ssr';
import {fail} from './db.js';

export type AuthOptions = {
  supabaseUrl?:string; supabaseAnonKey?:string; authMode?:'supabase'|'development';
  sessionSecret?:string; nodeEnv?:string; appOrigin?:string;
};
type Mode = 'supabase'|'development'|'unconfigured';
type User = {id:string; email:string};
type DevSession = {v:1; user:User; exp:number; jti:string};
const DEV_COOKIE = 'leadwork-dev-session';
const TTL = 8 * 60 * 60;
// Development only: process-local revocation survives createAuth instances, not restarts.
const revoked = new Map<string, number>();

function origin(value:string):string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return fail('unauthenticated');
    return url.origin;
  } catch { return fail('unauthenticated'); }
}
function requestOrigin(request:Request):string {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  if (host !== null && host.toLowerCase() !== url.host.toLowerCase()) fail('unauthenticated');
  return origin(url.origin);
}
/** Call for every state-changing HTTP route. Proxy headers are never an origin authority. */
export function assertMutationOrigin(request:Request, appOrigin?:string):void {
  const actual = request.headers.get('origin');
  const local = requestOrigin(request);
  if (!actual || origin(actual) !== (appOrigin === undefined ? local : origin(appOrigin))) fail('unauthenticated');
}
function loopback(host:string):boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
function emailAddress(value:string):string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim())) fail('invalid_value');
  return value.trim().toLowerCase();
}
function nextPath(request:Request, base:string):string {
  const params = new URL(request.url).searchParams;
  // Only a same-origin, absolute path is accepted, never a caller-selected redirect URL.
  if (['redirect', 'redirectTo', 'redirect_to', 'returnTo'].some(key => params.has(key))) fail('invalid_value');
  if (params.getAll('next').length > 1) fail('invalid_value');
  const next = params.get('next') ?? '/';
  let decoded:string;
  try { decoded = decodeURIComponent(next); } catch { return fail('invalid_value'); }
  if (!next.startsWith('/') || next.startsWith('//') || /[\\\x00-\x20\x7f]/.test(next) ||
      !decoded.startsWith('/') || decoded.startsWith('//') || /[\\\x00-\x20\x7f]/.test(decoded) ||
      new URL(next, base).origin !== base) fail('invalid_value');
  return next;
}
function cookieJar(request:Request):Map<string,string> {
  try {
    const jar = new Map<string,string>();
    const raw = request.headers.get('cookie') ?? '';
    const names = new Set<string>();
    // The SSR parser keeps the first duplicate; reject before it can erase ambiguity.
    for (const part of raw.split(';')) {
      const at = part.indexOf('=');
      if (at < 0) continue;
      const name = part.slice(0,at).trim();
      if (names.has(name)) return new Map();
      names.add(name);
    }
    for (const {name, value} of parseCookieHeader(raw)) {
      // Ambiguous cookies are not identities.
      if (jar.has(name)) return new Map();
      jar.set(name, value ?? '');
    }
    return jar;
  } catch { return new Map(); }
}

export function createAuth(options:AuthOptions = {}) {
  const production = (options.nodeEnv ?? process.env.NODE_ENV) === 'production' || process.env.NODE_ENV === 'production';
  const url = options.supabaseUrl ?? process.env.SUPABASE_URL;
  const key = options.supabaseAnonKey ?? process.env.SUPABASE_ANON_KEY;
  const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
  const appOrigin = options.appOrigin ?? process.env.APP_ORIGIN;
  const requested = options.authMode ?? process.env.AUTH_MODE;
  const devEnabled = requested === 'development' && !production &&
    !!secret && Buffer.byteLength(secret) >= 32;
  const mode:Mode = requested === 'development' ? (devEnabled ? 'development' : 'unconfigured') :
    (url && key ? 'supabase' : 'unconfigured');
  const mac = (value:string) => createHmac('sha256', secret!).update(value).digest('base64url');
  const identity = (email:string):User => {
    const bytes = createHmac('sha256', secret!).update(`leadwork:owner:${email}`).digest().subarray(0,16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return {id:`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`, email};
  };
  function devHost(request:Request):boolean {
    try {
      const local = requestOrigin(request);
      if (!loopback(new URL(local).hostname)) return false;
      if (appOrigin !== undefined && (origin(appOrigin) !== local || !loopback(new URL(appOrigin).hostname))) return false;
      // No proxy trust in this local-only mode, including loopback-targeted forwarded headers.
      return !['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for'].some(h => request.headers.has(h));
    } catch { return false; }
  }
  function available(request:Request):Mode {
    return mode === 'development' && !devHost(request) ? 'unconfigured' : mode;
  }
  function readDev(request:Request):DevSession|null {
    try {
      for (const [jti, exp] of revoked) if (exp <= Date.now() / 1000) revoked.delete(jti);
      const value = cookieJar(request).get(DEV_COOKIE);
      if (!value || value.length > 4096) return null;
      const parts = value.split('.');
      if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]!) || !/^[\w-]{43}$/.test(parts[1]!)) return null;
      const signature = Buffer.from(parts[1]!, 'utf8');
      const expected = Buffer.from(mac(parts[0]!), 'utf8');
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
      const payload = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as DevSession;
      if (payload.v !== 1 || !Number.isSafeInteger(payload.exp) || payload.exp <= Date.now()/1000 ||
          payload.exp > Date.now()/1000 + TTL + 1 || typeof payload.jti !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(payload.jti) || revoked.has(payload.jti) ||
          !payload.user || emailAddress(payload.user.email) !== payload.user.email ||
          identity(payload.user.email).id !== payload.user.id) return null;
      return payload;
    } catch { return null; }
  }
  function devCookie(headers:Headers, value:string, maxAge:number) {
    headers.append('set-cookie', serializeCookieHeader(DEV_COOKIE, value,
      {path:'/', httpOnly:true, secure:production, sameSite:'lax', maxAge}));
  }
  function server(request:Request, headers:Headers) {
    const jar = cookieJar(request);
    return createServerClient(url!, key!, {
      cookieOptions:{path:'/', httpOnly:true, secure:production, sameSite:'lax'},
      cookies:{
        getAll:() => [...jar].map(([name,value]) => ({name,value})),
        setAll:cookies => {
          for (const cookie of cookies) {
            jar.set(cookie.name, cookie.value);
            headers.append('set-cookie', serializeCookieHeader(cookie.name, cookie.value,
              {...cookie.options, path:'/', domain:undefined, httpOnly:true, secure:production, sameSite:'lax'}));
          }
        },
      },
    });
  }
  return {
    async session(request:Request):Promise<{user:User|null;mode:Mode;headers?:Headers}> {
      const current = available(request);
      if (current !== 'supabase') return {user:current === 'development' ? readDev(request)?.user ?? null : null, mode:current};
      const headers = new Headers();
      try {
        // Never trust getSession() or an unverified cookie's embedded user.
        const {data,error} = await server(request,headers).auth.getUser();
        return {user:!error && data.user?.id && data.user.email ? {id:data.user.id,email:data.user.email} : null,mode:current,headers};
      } catch { return {user:null,mode:current,headers}; }
    },
    async login(request:Request, email:string):Promise<{body:unknown;headers:Headers}> {
      assertMutationOrigin(request,appOrigin);
      const current = available(request);
      if (current === 'unconfigured') return fail('provider_not_ready');
      const normalized = emailAddress(email);
      const base = appOrigin === undefined ? requestOrigin(request) : origin(appOrigin);
      const next = nextPath(request,base);
      const headers = new Headers();
      if (current === 'development') {
        const payload:DevSession = {v:1,user:identity(normalized),exp:Math.floor(Date.now()/1000)+TTL,jti:randomUUID()};
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        devCookie(headers,`${encoded}.${mac(encoded)}`,TTL);
        return {body:{ok:true,mode:'development'},headers};
      }
      try {
        const redirect = new URL('/api/auth/callback',base);
        redirect.searchParams.set('next',next);
        const {error} = await server(request,headers).auth.signInWithOtp({email:normalized,options:{emailRedirectTo:redirect.href}});
        if (error) return fail('internal_error');
        return {body:{ok:true,mode:'supabase'},headers};
      } catch { return fail('internal_error'); }
    },
    async callback(request:Request):Promise<{body:unknown;headers:Headers}> {
      if (available(request) !== 'supabase') return fail('provider_not_ready');
      // Top-level email-link navigation has no Origin. PKCE binds it to the initiating browser.
      const base = appOrigin === undefined ? requestOrigin(request) : origin(appOrigin);
      const next = nextPath(request,base);
      const params = new URL(request.url).searchParams;
      const code = params.get('code');
      if (!code || code.length > 4096 || params.getAll('code').length !== 1) return fail('invalid_value');
      const headers = new Headers();
      try {
        const client = server(request,headers);
        const {error} = await client.auth.exchangeCodeForSession(code);
        if (error) return fail('unauthenticated');
        const validated = await client.auth.getUser();
        if (validated.error || !validated.data.user?.id) return fail('unauthenticated');
        return {body:{ok:true,next},headers};
      } catch { return fail('unauthenticated'); }
    },
    async logout(request:Request):Promise<{body:unknown;headers:Headers}> {
      assertMutationOrigin(request,appOrigin);
      const current = available(request);
      if (current === 'unconfigured') return fail('provider_not_ready');
      const headers = new Headers();
      if (current === 'development') {
        const payload = readDev(request);
        if (payload) revoked.set(payload.jti,payload.exp);
        devCookie(headers,'',0);
      } else {
        try {
          const {error} = await server(request,headers).auth.signOut();
          if (error) return fail('internal_error');
        } catch { return fail('internal_error'); }
      }
      return {body:{ok:true},headers};
    },
  };
}
