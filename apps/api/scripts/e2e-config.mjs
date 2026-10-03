import fs from 'node:fs';
export function cookieFor(state,base) {
  const url=new URL(base), now=Date.now()/1000;
  const cookies=(state.cookies||[]).filter(c=>{
    const domain=String(c.domain||'');
    const matches=domain.startsWith('.') ? url.hostname===domain.slice(1)||url.hostname.endsWith(domain) : url.hostname===domain;
    return c.name==='orlynx_session' && matches && (!c.secure||url.protocol==='https:') && (c.expires===-1||c.expires>now) && (!c.path||'/v1/'.startsWith(c.path));
  });
  const cookie=cookies.sort((a,b)=>(b.path||'').length-(a.path||'').length)[0];
  return cookie ? `${cookie.name}=${cookie.value}` : '';
}
export function sessionCookie(base,env=process.env) {
  if(env.ORLYNX_E2E_STORAGE_STATE) return cookieFor(JSON.parse(fs.readFileSync(env.ORLYNX_E2E_STORAGE_STATE,'utf8')),base);
  return env.ORLYNX_SESSION_COOKIE||'';
}
export function configuredTarget(env=process.env) {
  if(!env.ORLYNX_API||!env.ORLYNX_E2E_REPOSITORY) throw new Error('Set ORLYNX_API to the controlled test deployment and ORLYNX_E2E_REPOSITORY to the dedicated test repository.');
  const url=new URL(env.ORLYNX_API);
  if(url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)) throw new Error('ORLYNX_API must be an HTTP(S) origin without credentials or query parameters.');
  if(url.pathname!=='/')throw new Error('ORLYNX_API must be an origin without a path.');
  return url.origin;
}
