/** Read-only role commands bypass the shell entirely. No expansion, pipelines,
 * environment assignment, plugin hooks, or write-capable programs are allowed. */
export function readOnlyCommand(command: string): {executable: string; args: string[]} {
  if (/[$`;&|<>\n\r\0\\]/.test(command)) throw new Error('permission_denied: shell expansion is unavailable to read-only roles.');
  const tokens=command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g) || [];
  if(command.replace(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g,'').trim().length>0) throw new Error('permission_denied: malformed read-only command.');
  const parts=tokens.map(token=>/^['"]/.test(token)?token.slice(1,-1):token);
  const [executable,...args]=parts;
  if(!['pwd','ls','cat','head','tail','rg','grep','git'].includes(executable)) throw new Error('permission_denied: command is unavailable to read-only roles.');
  if(args.some(arg=>arg.startsWith('/') || arg.split('/').includes('..'))) throw new Error('permission_denied: paths must stay inside the workspace.');
  if(executable==='git') {
    if(!['status','diff','log','show'].includes(args[0])) throw new Error('permission_denied: Git mutation is unavailable to read-only roles.');
    if(args.some(arg=>/^(?:--output|--ext-diff|--textconv|--exec-path|--config-env|-c)(?:=|$)/.test(arg))) throw new Error('permission_denied: Git hooks are unavailable.');
    if(['diff','show'].includes(args[0])) args.splice(1,0,'--no-ext-diff','--no-textconv');
  }
  if(args.some(arg=>/^(?:--pre|--pre-glob|--open-files-in-pager|--follow|--dereference-recursive|-R|-L)(?:=|$)/.test(arg))) throw new Error('permission_denied: executable filters and symlink traversal are unavailable.');
  return {executable,args};
}
