export class MnemosyneRequestError extends Error {
  constructor(reasonCode, message, details = undefined) {
    super(message);
    this.name = 'MnemosyneRequestError';
    this.reasonCode = reasonCode;
    this.statusCode = 422;
    this.details = details;
  }
}
