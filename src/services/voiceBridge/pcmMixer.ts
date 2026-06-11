const SAMPLE_RATE = 48_000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Mixes mono PCM frames from multiple sources into one output frame. */
export class PcmMixer {
    private readonly buffers = new Map<string, Int16Array>();
    private readonly frameSize: number;

    constructor(frameSize = SAMPLES_PER_FRAME) {
        this.frameSize = frameSize;
    }

    push(sourceId: string, samples: Int16Array) {
        if (samples.length === 0) return;
        this.buffers.set(sourceId, samples);
    }

    remove(sourceId: string) {
        this.buffers.delete(sourceId);
    }

    mix(): Int16Array {
        const out = new Int16Array(this.frameSize);
        if (this.buffers.size === 0) return out;

        for (const samples of this.buffers.values()) {
            const len = Math.min(samples.length, this.frameSize);
            for (let i = 0; i < len; i++) {
                const mixed = out[i]! + samples[i]!;
                out[i] = mixed > 32767 ? 32767 : mixed < -32768 ? -32768 : mixed;
            }
        }

        return out;
    }

    clear() {
        this.buffers.clear();
    }
}

export { SAMPLE_RATE, FRAME_MS, SAMPLES_PER_FRAME };
