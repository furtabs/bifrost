import { Readable } from 'node:stream';

/**
 * Object-mode stream that emits Opus packets as soon as they arrive.
 * Downstream (@discordjs/voice / Fluxer playOpus) handles 20ms pacing.
 */
export class OpusPacketStream extends Readable {
    private readonly queue: Buffer[] = [];
    private halted = false;

    constructor() {
        super({ objectMode: true, highWaterMark: 16 });
    }

    pushPacket(packet: Buffer) {
        if (this.halted) return;
        this.queue.push(packet);
        this.drain();
    }

    private drain() {
        while (!this.halted && this.queue.length > 0) {
            const packet = this.queue[0]!;
            if (!this.push(packet)) {
                break;
            }
            this.queue.shift();
        }
    }

    override _read() {
        this.drain();
    }

    stop() {
        this.halted = true;
        this.queue.length = 0;
        this.removeAllListeners();
        this.destroy();
    }
}
