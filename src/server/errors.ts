export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, extra?: Record<string, unknown>) =>
  new ApiError(400, 'bad_request', message, extra);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
export const forbidden = (message: string) => new ApiError(403, 'forbidden', message);
export const unauthorized = (message = 'Missing or invalid API key') => new ApiError(401, 'unauthorized', message);
