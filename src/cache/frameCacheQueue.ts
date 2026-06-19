/** §28 プレビューキャッシュ書き込みの優先度キュー（scrub > playback > background）。 */

export type FrameCachePriority = "scrub" | "playback" | "background";

const PRIORITY_RANK: Record<FrameCachePriority, number> = {
  scrub: 0,
  playback: 1,
  background: 2,
};

interface QueueJob {
  frame: number;
  priority: FrameCachePriority;
  seq: number;
}

export type FrameCacheProcessor = (frame: number, generation: number) => Promise<void>;

export class FrameCacheQueue {
  private pending = new Map<number, QueueJob>();
  private seq = 0;
  private generation = 0;
  private pumping = false;

  enqueue(frame: number, priority: FrameCachePriority): void {
    const existing = this.pending.get(frame);
    if (existing) {
      if (PRIORITY_RANK[existing.priority] <= PRIORITY_RANK[priority]) return;
    }
    this.pending.set(frame, { frame, priority, seq: this.seq++ });
  }

  enqueueRange(start: number, end: number, priority: FrameCachePriority): void {
    for (let f = start; f < end; f++) this.enqueue(f, priority);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  abort(): void {
    this.generation += 1;
    this.pending.clear();
  }

  getGeneration(): number {
    return this.generation;
  }

  pump(processor: FrameCacheProcessor): void {
    void this.runPump(processor);
  }

  private pickNext(): QueueJob | null {
    let best: QueueJob | null = null;
    for (const job of this.pending.values()) {
      if (!best) {
        best = job;
        continue;
      }
      const rankDiff = PRIORITY_RANK[job.priority] - PRIORITY_RANK[best.priority];
      if (rankDiff < 0 || (rankDiff === 0 && job.seq < best.seq)) best = job;
    }
    return best;
  }

  private async runPump(processor: FrameCacheProcessor): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const gen = this.generation;
    try {
      while (gen === this.generation) {
        const job = this.pickNext();
        if (!job) break;
        this.pending.delete(job.frame);
        await processor(job.frame, gen);
        await yieldToMain();
      }
    } finally {
      this.pumping = false;
      if (this.pending.size > 0 && gen === this.generation) {
        void this.runPump(processor);
      }
    }
  }
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => resolve(), { timeout: 16 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
