export const EmbedColors = {
    Success: 0x57f287,
    Error: 0xed4245,
    Warning: 0xfee75c,
    Info: 0x9b59b6,
} as const;

const EMBED_DESCRIPTION_MAX = 4092;

export function chunkDescriptionLines(
    lines: string[],
    separator = '\n\n',
    maxLength = EMBED_DESCRIPTION_MAX
): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let currentLength = 0;

    for (const line of lines) {
        const addition =
            current.length === 0 ? line.length : separator.length + line.length;
        if (current.length > 0 && currentLength + addition > maxLength) {
            chunks.push(current);
            current = [line];
            currentLength = line.length;
        } else {
            current.push(line);
            currentLength += addition;
        }
    }

    if (current.length > 0) chunks.push(current);

    return chunks;
}
