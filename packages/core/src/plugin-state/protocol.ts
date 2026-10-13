export type StateRequest = { readonly type:'request'; readonly id:number; readonly target:string;
 readonly method:string; readonly args:readonly unknown[]; readonly deadlineAt:number };
export type StateResponse = { readonly type:'response'; readonly id:number; readonly physical?:boolean; readonly value?:unknown;
 readonly error?: { readonly name:string; readonly message:string; readonly code?:string; readonly operationId?:string|null } };
/** Response settlement and physical completion are independent. */
export type StatePhysical = { readonly type:'physical-settled'; readonly id:number };
export type StateCallback = { readonly type:'callback'; readonly id:number; readonly requestId:number; readonly deadlineAt:number;
 readonly token:string; readonly method:string; readonly args:readonly unknown[] };
export type StateCallbackResponse = { readonly type:'callback-response'; readonly id:number; readonly value?:unknown;
 readonly error?:string };
