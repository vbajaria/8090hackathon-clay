import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {test} from 'node:test';
import {createAuth, assertMutationOrigin} from '../dist/auth.js';
import {ServiceError} from '../dist/db.js';

const base = 'http://localhost:3100';
const secret = 'development-fixture-key-at-least-32-bytes';
const devOptions = {authMode:'development',nodeEnv:'test',sessionSecret:secret,appOrigin:base};
const dev = () => createAuth(devOptions);
const request = (path='/api/auth/session', {method='GET',cookie,origin,headers={},url=base}={}) => new Request(url+path, {
  method,headers:{...(cookie ? {cookie} : {}),...(origin === undefined ? {} : {origin}),...headers},
});
const mutation = (path,cookie,extra={}) => request(path,{method:'POST',origin:base,cookie,...extra});
const cookies = headers => headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const safeError = code => error => error instanceof ServiceError && error.error.code === code &&
  !JSON.stringify(error).includes('provider-secret-diagnostic');
const signIn = (auth,email='owner@fixture.example') => auth.login(mutation('/api/auth/login'),email);

// This suite makes no live network requests. Even an unexpected Supabase URL is intercepted.
function supabaseFixture(t,{otpError=false,exchangeError=false,userError=false,logoutError=false,expired=false}={}) {
  const calls = [];
  const user = {id:'10000000-0000-4000-8000-000000000001',email:'validated@fixture.example',aud:'authenticated',role:'authenticated',created_at:'2026-01-01T00:00:00Z',app_metadata:{},user_metadata:{}};
  const embeddedUser = {...user,email:'untrusted-cookie@fixture.example'};
  const jwt = `${Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+(expired ? -10 : 3600)})).toString('base64url')}.fixture-signature`;
  const session = {access_token:jwt,refresh_token:'fixture-refresh-token',token_type:'bearer',expires_in:expired ? -10 : 3600,user:embeddedUser};
  t.mock.method(globalThis,'fetch',async (input,init={}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({url,body,method:init.method ?? 'GET',headers:new Headers(init.headers)});
    const failure = () => new Response(JSON.stringify({msg:'provider-secret-diagnostic',error_code:'fixture_failure'}),{status:400,headers:{'content-type':'application/json'}});
    if (url.origin !== 'https://fixture.supabase.co') return failure();
    if (url.pathname === '/auth/v1/otp') return otpError ? failure() : Response.json({});
    if (url.pathname === '/auth/v1/token') {
      if (exchangeError) return failure();
      return Response.json(session);
    }
    if (url.pathname === '/auth/v1/user') return userError ? failure() : Response.json(user);
    if (url.pathname === '/auth/v1/logout') return logoutError ? failure() : new Response(null,{status:204});
    return failure();
  });
  const auth = createAuth({supabaseUrl:'https://fixture.supabase.co',supabaseAnonKey:'fixture-anon-key',nodeEnv:'production',appOrigin:'https://app.fixture.example'});
  const post = (path,cookie) => request(path,{url:'https://app.fixture.example',method:'POST',origin:'https://app.fixture.example',cookie});
  const callback = cookie => request('/api/auth/callback?code=fixture-code&next=%2Ftables',{url:'https://app.fixture.example',cookie});
  return {auth,calls,user,post,callback};
}

test('no configured Supabase means unconfigured, never a fake default owner',async () => {
  const auth = createAuth({authMode:'supabase',supabaseUrl:'',supabaseAnonKey:'',nodeEnv:'test'});
  assert.deepEqual(await auth.session(request()),{user:null,mode:'unconfigured'});
  await assert.rejects(signIn(auth),safeError('provider_not_ready'));
});

test('development sign-in is explicit, stable, distinct and cookie-only',async () => {
  const auth = dev();
  const first = await signIn(auth,'Owner@fixture.example');
  const second = await signIn(auth,'second@fixture.example');
  const firstSession = await auth.session(request(undefined,{cookie:cookies(first.headers)}));
  const secondSession = await auth.session(request(undefined,{cookie:cookies(second.headers)}));
  assert.equal(firstSession.mode,'development');
  assert.equal(firstSession.user.email,'owner@fixture.example');
  assert.match(firstSession.user.id,/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(firstSession.user.id,secondSession.user.id);
  const again = await signIn(dev());
  assert.equal((await dev().session(request(undefined,{cookie:cookies(again.headers)}))).user.id,firstSession.user.id);
  assert.deepEqual(first.body,{ok:true,mode:'development'});
  assert.match(first.headers.get('set-cookie'),/HttpOnly/);
  assert.match(first.headers.get('set-cookie'),/SameSite=Lax/);
  assert.match(first.headers.get('set-cookie'),/Max-Age=28800/);
  assert.match(first.headers.get('set-cookie'),/Path=\//);
});

test('development sign-out clears cookie and revokes replay across instances',async () => {
  const auth = dev();
  const login = await signIn(auth);
  const cookie = cookies(login.headers);
  const signedOut = await auth.logout(mutation('/api/auth/logout',cookie));
  assert.match(signedOut.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await auth.session(request(undefined,{cookie}))).user,null);
  assert.equal((await dev().session(request(undefined,{cookie}))).user,null);
  const fresh = await signIn(auth);
  assert.ok((await auth.session(request(undefined,{cookie:cookies(fresh.headers)}))).user);
});

test('tampered, expired, malformed and caller-selected identities fail closed',async () => {
  const auth = dev();
  const login = await signIn(auth);
  const cookie = cookies(login.headers);
  const value = cookie.slice(cookie.indexOf('=')+1);
  const payload = JSON.parse(Buffer.from(value.split('.')[0],'base64url').toString());
  const signed = body => {
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
    return `leadwork-dev-session=${encoded}.${createHmac('sha256',secret).update(encoded).digest('base64url')}`;
  };
  for (const bad of [
    cookie.slice(0,-4)+'abcd', 'leadwork-dev-session=bad',
    signed({...payload,exp:Math.floor(Date.now()/1000)-1}),
    signed({...payload,user:{...payload.user,id:'20000000-0000-4000-8000-000000000002'}}),
    signed({...payload,exp:payload.exp+999999}),
    `${cookie}; ${cookie}`,
  ]) assert.equal((await auth.session(request(undefined,{cookie:bad}))).user,null);
  assert.equal((await auth.session(request(undefined,{headers:{authorization:'Bearer caller-token','x-owner-id':payload.user.id}}))).user,null);
});

test('explicit development requires nonproduction environment and >=32-byte secret',async () => {
  for (const options of [
    {...devOptions,nodeEnv:'production'}, {...devOptions,sessionSecret:'x'.repeat(31)},
    {...devOptions,sessionSecret:''}, {...devOptions,sessionSecret:'short'},
  ]) {
    const auth = createAuth(options);
    assert.deepEqual(await auth.session(request()),{user:null,mode:'unconfigured'});
    await assert.rejects(signIn(auth),safeError('provider_not_ready'));
  }
  assert.equal((await createAuth({...devOptions,nodeEnv:'nonproduction'}).session(request())).mode,'development');
  const auth = createAuth({...devOptions,authMode:'supabase',supabaseUrl:'',supabaseAnonKey:''});
  assert.equal((await auth.session(request())).mode,'unconfigured');
});

test('development is loopback-only and rejects host/proxy spoofing and nonlocal appOrigin',async () => {
  const auth = dev();
  const login = await signIn(auth);
  for (const req of [
    request(undefined,{url:'http://public.fixture.example',cookie:cookies(login.headers)}),
    request(undefined,{headers:{host:'public.fixture.example'}}),
    request(undefined,{headers:{'x-forwarded-host':'localhost:3100'}}),
    request(undefined,{headers:{forwarded:'host=localhost:3100;proto=http'}}),
    request(undefined,{headers:{'x-forwarded-proto':'https'}}),
  ]) assert.deepEqual(await auth.session(req),{user:null,mode:'unconfigured'});
  assert.equal((await createAuth({...devOptions,appOrigin:'https://app.fixture.example'}).session(request())).mode,'unconfigured');
  for (const host of ['127.0.0.1','[::1]']) {
    const local = `http://${host}:3100`;
    const instance = createAuth({...devOptions,appOrigin:local});
    assert.equal((await instance.session(request(undefined,{url:local}))).mode,'development');
  }
});

test('mutation origins include scheme and port, reject null/missing and never trust forwarding',async () => {
  assert.doesNotThrow(() => assertMutationOrigin(mutation('/api/tables')));
  assert.doesNotThrow(() => assertMutationOrigin(mutation('/api/tables'),base));
  for (const candidate of [undefined,'null','http://localhost','http://localhost:3101','https://localhost:3100','http://evil.fixture.example','http://localhost:3100/path','http://user@localhost:3100']) {
    assert.throws(() => assertMutationOrigin(request('/api/tables',{method:'POST',origin:candidate})),safeError('unauthenticated'));
  }
  assert.throws(() => assertMutationOrigin(mutation('/api/tables',undefined,{headers:{host:'evil.fixture.example'}})),safeError('unauthenticated'));
  assert.throws(() => assertMutationOrigin(mutation('/api/tables',undefined,{origin:'https://evil.fixture.example',headers:{'x-forwarded-host':'evil.fixture.example','x-forwarded-proto':'https'}})),safeError('unauthenticated'));
  // A server fixture may explicitly supply its configured app origin.
  assert.doesNotThrow(() => assertMutationOrigin(request('/api/tables',{method:'POST',origin:'https://app.fixture.example'}),'https://app.fixture.example'));
});

test('login and logout enforce origin before auth work',async () => {
  const auth = dev();
  for (const candidate of [undefined,'null','https://evil.fixture.example']) {
    const req = request('/api/auth/login',{method:'POST',origin:candidate});
    await assert.rejects(auth.login(req,'owner@fixture.example'),safeError('unauthenticated'));
    await assert.rejects(auth.logout(req),safeError('unauthenticated'));
  }
});

test('unsafe next and redirect inputs are rejected before sign-in',async () => {
  const auth = dev();
  for (const query of [
    'next=https://evil.fixture.example', 'next=//evil.fixture.example',
    'next=%2F%5Cevil.fixture.example','next=%2F%252Fevil.fixture.example',
    'next=%2F%250Aevil', 'next=/&next=/tables', 'redirectTo=https://evil.fixture.example',
  ]) await assert.rejects(auth.login(mutation(`/api/auth/login?${query}`),'owner@fixture.example'),safeError('invalid_value'));
  for (const email of ['', 'not-email', 'owner\n@fixture.example']) await assert.rejects(signIn(auth,email),safeError('invalid_value'));
});

test('Supabase OTP uses PKCE HttpOnly secure cookies and same-origin callback without token response',async t => {
  const f = supabaseFixture(t);
  const login = await f.auth.login(f.post('/api/auth/login?next=%2Ftables'),'owner@fixture.example');
  assert.deepEqual(login.body,{ok:true,mode:'supabase'});
  assert.match(login.headers.get('set-cookie'),/code-verifier/);
  for (const value of login.headers.getSetCookie()) {
    assert.match(value,/HttpOnly/); assert.match(value,/Secure/); assert.match(value,/SameSite=Lax/);
  }
  const otp = f.calls.find(call => call.url.pathname.endsWith('/otp'));
  assert.equal(otp.body.email,'owner@fixture.example');
  assert.equal(otp.body.code_challenge_method,'s256');
  assert.ok(otp.body.code_challenge);
  const redirect = new URL(otp.url.searchParams.get('redirect_to'));
  assert.equal(redirect.origin,'https://app.fixture.example');
  assert.equal(redirect.pathname,'/api/auth/callback');
  assert.equal(redirect.searchParams.get('next'),'/tables');
  const callback = await f.auth.callback(f.callback(cookies(login.headers)));
  assert.deepEqual(callback.body,{ok:true,next:'/tables'});
  assert.ok(callback.headers.getSetCookie().length);
  for (const value of callback.headers.getSetCookie()) {
    assert.match(value,/HttpOnly/); assert.match(value,/Secure/); assert.match(value,/SameSite=Lax/);
  }
  const exchange = f.calls.find(call => call.url.pathname.endsWith('/token'));
  assert.equal(exchange.url.searchParams.get('grant_type'),'pkce');
  assert.equal(exchange.body.auth_code,'fixture-code');
  assert.ok(exchange.body.code_verifier);
  const session = await f.auth.session(request(undefined,{url:'https://app.fixture.example',cookie:cookies(callback.headers)}));
  assert.deepEqual(session.user,{id:f.user.id,email:f.user.email});
  assert.equal(session.mode,'supabase');
  assert.ok(f.calls.filter(call => call.url.pathname.endsWith('/user')).length >= 2);
  assert.equal(JSON.stringify(callback.body).includes('access_token'),false);
  const signedOut = await f.auth.logout(f.post('/api/auth/logout',cookies(callback.headers)));
  assert.deepEqual(signedOut.body,{ok:true});
  assert.ok(signedOut.headers.getSetCookie().some(value => /Max-Age=0/.test(value)));
  assert.ok(f.calls.some(call => call.url.pathname.endsWith('/logout')));
});

test('Supabase sessions do not accept missing cookies or caller bearer identity',async t => {
  const f = supabaseFixture(t);
  for (const headers of [{},{authorization:'Bearer fixture-access-token','x-owner-id':f.user.id},{cookie:'sb-fixture-auth-token=malformed'}]) {
    const result = await f.auth.session(request(undefined,{url:'https://app.fixture.example',headers}));
    assert.equal(result.user,null);
  }
  assert.equal(f.calls.length,0);
});

test('Supabase provider errors are fixed safe ServiceErrors and do not disclose diagnostics',async t => {
  const f = supabaseFixture(t,{otpError:true});
  await assert.rejects(f.auth.login(f.post('/api/auth/login'),'owner@fixture.example'),safeError('internal_error'));
});

test('Supabase exchange failure is sanitized; unsafe callback cannot make a request',async t => {
  const f = supabaseFixture(t,{exchangeError:true});
  await assert.rejects(f.auth.callback(f.callback()),safeError('unauthenticated'));
  const count = f.calls.length;
  for (const path of ['/api/auth/callback','/api/auth/callback?code=x&code=y','/api/auth/callback?code=x&next=//evil.fixture.example']) {
    await assert.rejects(f.auth.callback(request(path,{url:'https://app.fixture.example'})),safeError('invalid_value'));
  }
  assert.equal(f.calls.length,count);
});

test('Supabase getUser failure denies even a cookie carrying a user',async t => {
  const f = supabaseFixture(t);
  const login = await f.auth.login(f.post('/api/auth/login'),'owner@fixture.example');
  const callback = await f.auth.callback(f.callback(cookies(login.headers)));
  // Override only the validated-user response; an embedded user must not grant access.
  const original = globalThis.fetch;
  t.mock.method(globalThis,'fetch',async (input,init) => String(input).includes('/auth/v1/user') ?
    Response.json({msg:'provider-secret-diagnostic'},{status:401}) : original(input,init));
  const session = await f.auth.session(request(undefined,{url:'https://app.fixture.example',cookie:cookies(callback.headers)}));
  assert.equal(session.user,null);
});

test('Supabase refresh propagates changed HttpOnly cookies through session headers',async t => {
  const f = supabaseFixture(t);
  const login = await f.auth.login(f.post('/api/auth/login'),'owner@fixture.example');
  const callback = await f.auth.callback(f.callback(cookies(login.headers)));
  const authCookie = callback.headers.getSetCookie().find(value => value.startsWith('sb-fixture-auth-token=')).split(';')[0];
  const at = authCookie.indexOf('=');
  const value = decodeURIComponent(authCookie.slice(at+1));
  assert.ok(value.startsWith('base64-'));
  const stored = JSON.parse(Buffer.from(value.slice(7),'base64url').toString());
  stored.expires_at = Math.floor(Date.now()/1000)-100;
  const expired = authCookie.slice(0,at+1)+'base64-'+Buffer.from(JSON.stringify(stored)).toString('base64url');
  const session = await f.auth.session(request(undefined,{url:'https://app.fixture.example',cookie:expired}));
  assert.deepEqual(session.user,{id:f.user.id,email:f.user.email});
  assert.ok(f.calls.some(call => call.url.searchParams.get('grant_type') === 'refresh_token'));
  assert.ok(session.headers.getSetCookie().length);
  for (const value of session.headers.getSetCookie()) {
    assert.match(value,/HttpOnly/); assert.match(value,/Secure/); assert.match(value,/SameSite=Lax/);
  }
});

test('Supabase logout failure cannot leak provider diagnostics',async t => {
  const f = supabaseFixture(t,{logoutError:true});
  const login = await f.auth.login(f.post('/api/auth/login'),'owner@fixture.example');
  const callback = await f.auth.callback(f.callback(cookies(login.headers)));
  await assert.rejects(f.auth.logout(f.post('/api/auth/logout',cookies(callback.headers))),safeError('internal_error'));
});

test('production process cannot be bypassed by the nodeEnv option',async t => {
  const previous = process.env.NODE_ENV;
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  process.env.NODE_ENV = 'production';
  const auth = createAuth(devOptions);
  assert.deepEqual(await auth.session(request()),{user:null,mode:'unconfigured'});
  await assert.rejects(signIn(auth),safeError('provider_not_ready'));
});

test('secret rotation invalidates development cookies and noncanonical signatures are tampered',async () => {
  const login = await signIn(dev());
  const cookie = cookies(login.headers);
  const rotated = createAuth({...devOptions,sessionSecret:secret+'-rotated'});
  assert.equal((await rotated.session(request(undefined,{cookie}))).user,null);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // Base64url's unused low bits are not a second spelling of a valid signature.
  const last = alphabet.indexOf(cookie.at(-1));
  const noncanonical = cookie.slice(0,-1)+alphabet[last | 1];
  assert.notEqual(noncanonical,cookie);
  assert.equal((await dev().session(request(undefined,{cookie:noncanonical}))).user,null);
});

test('explicit loopback-bound Next bridge permits only exact local forwarding metadata', async () => {
  const a=createAuth({authMode:'development',nodeEnv:'test',sessionSecret:'s'.repeat(32),appOrigin:'http://localhost:3000',allowLoopbackForwarding:true});
  const headers={'host':'localhost:3000','origin':'http://localhost:3000','x-forwarded-host':'localhost:3000','x-forwarded-proto':'http','x-forwarded-port':'3000','x-forwarded-for':'127.0.0.1'};
  const local=new Request('http://localhost:3000/api/auth/login',{method:'POST',headers});
  assert.equal((await a.session(local)).mode,'development');
  for(const [field,value] of [['x-forwarded-for','203.0.113.1'],['x-forwarded-host','outside.example'],['x-forwarded-proto','https'],['x-forwarded-port','80'],['forwarded','for=127.0.0.1']]) {
    assert.equal((await a.session(new Request(local.url,{headers:{...headers,[field]:value}}))).mode,'unconfigured');
  }
});
