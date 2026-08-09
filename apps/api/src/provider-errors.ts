export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }

  get authorizationInvalid(): boolean {
    return (
      this.status === 401 ||
      [
        "account_inactive",
        "invalid_auth",
        "invalid_grant",
        "not_authed",
        "token_expired",
        "token_revoked",
      ].includes(this.code)
    );
  }
}
