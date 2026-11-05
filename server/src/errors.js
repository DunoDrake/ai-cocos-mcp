export class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.data = data;
  }
}

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}
