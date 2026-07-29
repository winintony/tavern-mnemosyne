import { censusMark } from '../inspection/gate-census.js';

export class MnemosyneRequestError extends Error {
  constructor(reasonCode, message, details = undefined) {
    super(message);
    this.name = 'MnemosyneRequestError';
    this.reasonCode = reasonCode;
    this.statusCode = 422;
    this.details = details;
    // Pass the instance itself, not `this.stack`: reading `.stack` can
    // invoke a host-installed `Error.prepareStackTrace` that throws, so the
    // property access must happen inside censusMark's enabled-gated
    // try/catch, never here unconditionally (P0-1).
    censusMark('MRE', 'raised', {
      reasonCode,
      cls: 'MnemosyneRequestError',
      errorForSite: this,
    });
  }
}
