import { api } from './client';
import { restoreSession, logout, authMode, type ManagementSubject } from '$stores/auth';
export interface LoginResponse { success:boolean; mode?:'anonymous'|'plugin'; error?:string; subject?:ManagementSubject; csrfToken?:string }
export async function verifyToken(options: {preserveSessionOnFailure?:boolean} = {}):Promise<LoginResponse> {
  const result=await api.get<LoginResponse>('/auth/verify',{preserveSessionOnUnauthorized:true});
  if (result.success || !options.preserveSessionOnFailure) restoreSession(result);
  return result;
}
export interface AuthMode { mode:'anonymous'|'plugin'; initialized?:boolean; publicOrigin?:string; provider?:{name:string;loginComponent?:string} }
export async function readAuthMode(): Promise<AuthMode> { const mode=await api.get<AuthMode>('/auth/mode'); authMode.set(mode); return mode; }
export async function endSession():Promise<void> { try { await api.post('/auth/logout',{}); } finally { logout(); } }
