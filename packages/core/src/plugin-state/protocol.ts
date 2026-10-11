export type StateRequest = { readonly type:'request'; readonly id:number; readonly target:string;
 readonly method:string; readonly args:readonly unknown[] };
export type StateResponse = { readonly type:'response'; readonly id:number; readonly value?:unknown;
 readonly error?: { readonly name:string; readonly message:string; readonly code?:string; readonly operationId?:string|null } };
export type StateCallback = { readonly type:'callback'; readonly id:number; readonly token:string; readonly method:string;
 readonly args:readonly unknown[] };
export type StateCallbackResponse = { readonly type:'callback-response'; readonly id:number; readonly value?:unknown;
 readonly error?:string };
