export class ValidationError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
  }
}

export class ConflictError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
    this.code = code;
  }
}

export class RuleViolationError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "RuleViolationError";
    this.statusCode = 422;
    this.details = details;
  }
}
