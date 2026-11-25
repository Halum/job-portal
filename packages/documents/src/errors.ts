export class DocumentsError extends Error {
  constructor(
    readonly code: 'not_found' | 'unsupported_type' | 'invalid_argument',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentsError';
  }
}
