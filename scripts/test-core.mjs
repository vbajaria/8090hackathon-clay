import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
const root=new URL('../',import.meta.url);
if(process.env.NODE_ENV==='production'){console.error('Do not run fixture tests in production.');process.exit(1);}
let url=process.env.TEST_DATABASE_URL;
if(!url&&process.env.CI==='true')url=process.env.DATABASE_URL;
if(!url){let local={};try{local=parseEnv(readFileSync(new URL('.env',root),'utf8'));}catch{}const main=new URL(local.DATABASE_URL??'postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork');if(!['localhost','127.0.0.1','[::1]'].includes(main.hostname)||main.pathname!=='/leadwork'){console.error('Set TEST_DATABASE_URL to an isolated verification database.');process.exit(1);}main.pathname='/leadwork_test';url=main.href;}
const {Database}=await import('../packages/core/dist/db.js');const {migrate}=await import('../packages/core/dist/migrate.js');const db=new Database(url);try{await migrate(db);}finally{await db.close();}
const files=readdirSync(new URL('packages/core/test/',root)).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>new URL('packages/core/test/'+f,root).pathname);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',env:{...process.env,DATABASE_URL:url}});
process.exit(result.status??1);
