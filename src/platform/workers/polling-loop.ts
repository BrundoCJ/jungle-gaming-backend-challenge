import type { LoggerService } from '@nestjs/common';

/**
 * Runs `tick` repeatedly: immediately again when it reports more work,
 * otherwise after `intervalMs`. stop() waits for the running tick to finish.
 */
export class PollingLoop {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<boolean>,
    private readonly intervalMs: number,
    private readonly logger: LoggerService,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.current;
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      this.current = this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    let moreWork = false;
    try {
      moreWork = await this.tick();
    } catch (error) {
      this.logger.error(error instanceof Error ? error : String(error), this.name);
    } finally {
      this.current = undefined;
      this.schedule(moreWork ? 0 : this.intervalMs);
    }
  }
}
