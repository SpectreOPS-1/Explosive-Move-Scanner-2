export class ProviderError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
