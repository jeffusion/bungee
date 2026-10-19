export class AccountError extends Error {
    constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function fail(code: string, status = 400): never { throw new AccountError(code, status); }
