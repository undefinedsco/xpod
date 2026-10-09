/** A protocol error safe to expose to Matrix clients. Backend errors must remain private. */
export class MatrixError extends Error {
  public constructor(public readonly status: number, public readonly errcode: string, message: string) {
    super(message);
    this.name = 'MatrixError';
  }
}
