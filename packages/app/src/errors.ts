/** An error with the status the person's request deserves, and words a person can read. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, message);
export const notFound = (message: string): HttpError => new HttpError(404, message);
