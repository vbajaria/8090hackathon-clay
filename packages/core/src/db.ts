import {Pool, type PoolClient} from 'pg';
import {apiError,type ApiError} from '@leadwork/contracts';
export class ServiceError extends Error { constructor(public error:ApiError,public extra:Record<string,unknown>={}){super(error.message);} }
export function fail(code:Parameters<typeof apiError>[0],extra:Record<string,unknown>={}):never {throw new ServiceError(apiError(code),extra);}
export type Tx=PoolClient;
export class Database {
 readonly pool:Pool;
 constructor(url:string){this.pool=new Pool({connectionString:url,max:10});}
 async transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>{const tx=await this.pool.connect();try{await tx.query('BEGIN');const result=await fn(tx);await tx.query('COMMIT');return result;}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}}
 async close(){await this.pool.end();}
}
