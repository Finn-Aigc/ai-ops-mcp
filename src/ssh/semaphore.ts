import { AppError } from "../errors/app-error.js";

export class Semaphore {
  private active = 0;

  constructor(private readonly limit: number) {}

  acquire(): () => void {
    if (this.active >= this.limit) {
      throw new AppError("CONCURRENCY_LIMIT", `Concurrent operation limit (${this.limit}) reached.`, { retriable: true });
    }
    this.active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
  }
}
