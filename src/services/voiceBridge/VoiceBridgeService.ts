import { Client as DiscordClient, VoiceBasedChannel } from 'discord.js';
import {
    AudioPlayer,
    EndBehaviorType,
    StreamType,
    VoiceConnection,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    getVoiceConnection,
    joinVoiceChannel,
} from '@discordjs/voice';
import { Client as FluxerClient, VoiceChannel } from '@fluxerjs/core';
import {
    LiveKitRtcConnection,
    getVoiceManager,
} from '@fluxerjs/voice';
import prism from 'prism-media';
import { Readable } from 'node:stream';
import { VoiceLink } from '../../db/entities/VoiceLink';
import { LinkService } from '../LinkService';
import logger from '../../utils/logging/logger';
import { OpusPacketStream } from './OpusPacketStream';
import { PcmMixer, SAMPLE_RATE, SAMPLES_PER_FRAME } from './pcmMixer';

type ActiveBridge = {
    voiceLink: VoiceLink;
    discordConnection: VoiceConnection;
    discordPlayer: AudioPlayer;
    fluxerConnection: LiveKitRtcConnection | null;
    opusEncoder: prism.opus.Encoder;
    fluxerReceiveSubs: { stop: () => void }[];
    discordToFluxerOpus: OpusPacketStream;
    fluxerToDiscordOpus: OpusPacketStream;
    discordMixer: PcmMixer;
    fluxerMixer: PcmMixer;
    discordUserSubs: Map<string, Readable>;
    /** Raw opus passthrough when only one Discord speaker (no decode/re-encode). */
    discordPassthroughUsers: Set<string>;
};

export default class VoiceBridgeService {
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;
    private readonly linkService: LinkService;
    private readonly activeBridges = new Map<string, ActiveBridge>();
    /** Prevents overlapping ensureBridge runs for the same link (voice state spam). */
    private readonly startingBridges = new Set<string>();
    /** Discord allows one voice connection per guild — serialize bridge startup. */
    private readonly startingGuilds = new Set<string>();

    constructor(linkService: LinkService) {
        this.linkService = linkService;
    }

    setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    async onDiscordVoiceStateUpdate(guildId: string, userId: string) {
        if (!this.discordClient || userId === this.discordClient.user?.id) {
            return;
        }

        const guildLink = await this.linkService
            .getGuildLinkForDiscordGuild(guildId)
            .catch(() => null);
        if (!guildLink) return;

        let voiceLinks;
        try {
            voiceLinks =
                await this.linkService.getVoiceLinksForDiscordGuild(guildId);
        } catch {
            return;
        }

        for (const link of voiceLinks) {
            await this.syncBridgeForLink(link);
        }
    }

    async onFluxerVoiceStateUpdate(guildId: string, userId: string) {
        if (!this.fluxerClient || userId === this.fluxerClient.user?.id) {
            return;
        }

        const guildLink = await this.linkService
            .getGuildLinkForFluxerGuild(guildId)
            .catch(() => null);
        if (!guildLink) return;

        let voiceLinks;
        try {
            voiceLinks =
                await this.linkService.getVoiceLinksForFluxerGuild(guildId);
        } catch {
            return;
        }

        for (const link of voiceLinks) {
            await this.syncBridgeForLink(link);
        }
    }

    private async syncBridgeForLink(voiceLink: VoiceLink) {
        const hasHumans =
            (await this.hasHumanParticipants(voiceLink, 'discord')) ||
            (await this.hasHumanParticipants(voiceLink, 'fluxer'));

        if (hasHumans) {
            await this.ensureBridge(voiceLink);
        } else if (this.activeBridges.has(voiceLink.id)) {
            await this.stopBridge(voiceLink.id);
        }
    }

    async onVoiceLinkCreated(voiceLink: VoiceLink) {
        await this.ensureBridge(voiceLink);
    }

    async onVoiceLinkRemoved(voiceLink: VoiceLink) {
        await this.stopBridge(voiceLink.id);
    }

    private async hasHumanParticipants(
        voiceLink: VoiceLink,
        side: 'discord' | 'fluxer'
    ): Promise<boolean> {
        if (side === 'discord') {
            if (!this.discordClient) return false;
            const guildLink = await this.linkService.getGuildLinkById(
                voiceLink.guildLinkId
            );
            if (!guildLink) return false;
            const guild = await this.discordClient.guilds
                .fetch(guildLink.discordGuildId)
                .catch(() => null);
            if (!guild) return false;
            let channel =
                guild.channels.cache.get(voiceLink.discordChannelId) ?? null;
            if (!channel) {
                channel = await guild.channels
                    .fetch(voiceLink.discordChannelId)
                    .catch(() => null);
            }
            if (!channel || !('members' in channel)) return false;
            const members = (
                channel as VoiceBasedChannel
            ).members.filter(
                (m) => !m.user.bot && m.id !== this.discordClient?.user?.id
            );
            return members.size > 0;
        }

        if (!this.fluxerClient) return false;
        const voiceManager = getVoiceManager(this.fluxerClient);
        const guildLink = await this.linkService.getGuildLinkById(
            voiceLink.guildLinkId
        );
        if (!guildLink) return false;
        const participants = voiceManager.listParticipantsInChannel(
            guildLink.fluxerGuildId,
            voiceLink.fluxerChannelId
        );
        return participants.some((id) => id !== this.fluxerClient?.user?.id);
    }

    private async ensureBridge(voiceLink: VoiceLink) {
        if (this.activeBridges.has(voiceLink.id)) return;
        if (this.startingBridges.has(voiceLink.id)) return;
        if (!this.discordClient || !this.fluxerClient) return;

        const guildLink = await this.linkService.getGuildLinkById(
            voiceLink.guildLinkId
        );
        if (!guildLink) return;

        if (this.startingGuilds.has(guildLink.discordGuildId)) return;

        const hasDiscord = await this.hasHumanParticipants(
            voiceLink,
            'discord'
        );
        const hasFluxer = await this.hasHumanParticipants(voiceLink, 'fluxer');
        if (!hasDiscord && !hasFluxer) return;

        this.startingBridges.add(voiceLink.id);
        this.startingGuilds.add(guildLink.discordGuildId);
        let discordConnection: VoiceConnection | null = null;
        let logStateChange:
            | ((oldState: { status: string }, newState: { status: string }) => void)
            | null = null;

        try {
            const discordGuild = await this.discordClient.guilds.fetch(
                guildLink.discordGuildId
            );
            const discordChannel = await discordGuild.channels.fetch(
                voiceLink.discordChannelId
            );
            if (!discordChannel || !discordChannel.isVoiceBased()) {
                logger.warn(
                    `Voice bridge: Discord channel ${voiceLink.discordChannelId} is not voice-based`
                );
                return;
            }

            discordConnection =
                getVoiceConnection(guildLink.discordGuildId) ?? null;
            if (
                !discordConnection ||
                discordConnection.joinConfig.channelId !==
                    voiceLink.discordChannelId
            ) {
                if (discordConnection) {
                    logger.info(
                        `Voice bridge: moving Discord connection to channel ${voiceLink.discordChannelId}`
                    );
                    discordConnection.destroy();
                }
                discordConnection = joinVoiceChannel({
                    channelId: voiceLink.discordChannelId,
                    guildId: guildLink.discordGuildId,
                    adapterCreator: discordGuild.voiceAdapterCreator,
                    selfDeaf: false,
                    selfMute: false,
                });
            }

            logStateChange = (oldState, newState) => {
                logger.info(
                    `Voice bridge Discord connection (${voiceLink.discordChannelId}): ${oldState.status} → ${newState.status}`
                );
            };
            discordConnection.on('stateChange', logStateChange);

            await entersState(
                discordConnection,
                VoiceConnectionStatus.Ready,
                30_000
            );

            if (
                !(await this.hasHumanParticipants(voiceLink, 'discord')) &&
                !(await this.hasHumanParticipants(voiceLink, 'fluxer'))
            ) {
                logger.info(
                    `Voice bridge: no participants left before bridge finished starting`
                );
                discordConnection.destroy();
                return;
            }

            const fluxerGuild = await this.fluxerClient.guilds.fetch(
                guildLink.fluxerGuildId
            );
            if (!fluxerGuild) {
                discordConnection.destroy();
                return;
            }
            const fluxerChannels = await fluxerGuild.fetchChannels();
            const fluxerChannel = fluxerChannels.find(
                (ch) => ch.id === voiceLink.fluxerChannelId
            );
            if (!(fluxerChannel instanceof VoiceChannel)) {
                logger.warn(
                    `Voice bridge: Fluxer channel ${voiceLink.fluxerChannelId} is not a voice channel`
                );
                discordConnection.destroy();
                return;
            }

            const voiceManager = getVoiceManager(this.fluxerClient);
            const fluxerRaw = await voiceManager.join(fluxerChannel);
            const fluxerConnection =
                fluxerRaw instanceof LiveKitRtcConnection
                    ? fluxerRaw
                    : null;

            const discordToFluxerOpus = new OpusPacketStream();
            const fluxerToDiscordOpus = new OpusPacketStream();

            const discordPlayer = createAudioPlayer();
            const discordResource = createAudioResource(
                fluxerToDiscordOpus,
                { inputType: StreamType.Opus }
            );
            discordPlayer.play(discordResource);
            discordConnection.subscribe(discordPlayer);

            const fluxerReceiveSubs: { stop: () => void }[] = [];
            if (fluxerConnection) {
                fluxerConnection.playOpus(discordToFluxerOpus);
                fluxerReceiveSubs.push(
                    ...voiceManager.subscribeChannelParticipants(
                        voiceLink.fluxerChannelId
                    )
                );
            }

            const bridge: ActiveBridge = {
                voiceLink,
                discordConnection,
                discordPlayer,
                fluxerConnection,
                opusEncoder: new prism.opus.Encoder({
                    rate: SAMPLE_RATE,
                    channels: 2,
                    frameSize: SAMPLES_PER_FRAME,
                }),
                fluxerReceiveSubs,
                discordToFluxerOpus,
                fluxerToDiscordOpus,
                discordMixer: new PcmMixer(),
                fluxerMixer: new PcmMixer(),
                discordUserSubs: new Map(),
                discordPassthroughUsers: new Set(),
            };

            if (fluxerConnection) {
                fluxerConnection.on('audioFrame', (frame) => {
                    this.handleFluxerAudioFrame(
                        voiceLink.id,
                        frame.participantId,
                        frame.samples
                    );
                });
            }

            this.setupDiscordReceive(bridge);
            this.activeBridges.set(voiceLink.id, bridge);

            logger.info(
                `Voice bridge active: Discord ${voiceLink.discordChannelId} ↔ Fluxer ${voiceLink.fluxerChannelId}`
            );
        } catch (err) {
            const status = discordConnection?.state.status ?? 'unknown';
            logger.error(
                `Failed to start voice bridge (Discord ${voiceLink.discordChannelId} ↔ Fluxer ${voiceLink.fluxerChannelId}, connection status: ${status}):`,
                err
            );
            if (
                discordConnection &&
                !this.activeBridges.has(voiceLink.id)
            ) {
                discordConnection.destroy();
            }
        } finally {
            if (discordConnection && logStateChange) {
                discordConnection.off('stateChange', logStateChange);
            }
            this.startingBridges.delete(voiceLink.id);
            this.startingGuilds.delete(guildLink.discordGuildId);
        }
    }

    private useDiscordPassthrough(bridge: ActiveBridge): boolean {
        return bridge.discordPassthroughUsers.size <= 1;
    }

    private refreshDiscordPassthroughMode(bridge: ActiveBridge) {
        const passthrough = this.useDiscordPassthrough(bridge);

        for (const [userId, stream] of bridge.discordUserSubs) {
            stream.removeAllListeners('data');
            stream.unpipe();

            if (passthrough) {
                stream.on('data', (opus: Buffer) => {
                    if (this.useDiscordPassthrough(bridge)) {
                        bridge.discordToFluxerOpus.pushPacket(opus);
                    }
                });
            } else {
                this.attachDiscordDecoder(bridge, userId, stream);
            }
        }
    }

    private attachDiscordDecoder(
        bridge: ActiveBridge,
        userId: string,
        stream: Readable
    ) {
        const decoder = new prism.opus.Decoder({
            rate: SAMPLE_RATE,
            channels: 2,
            frameSize: SAMPLES_PER_FRAME,
        });
        stream.pipe(decoder);

        decoder.on('data', (pcm: Buffer) => {
            bridge.discordMixer.push(userId, this.stereoToMono(pcm));
            this.forwardDiscordMixed(bridge);
        });
    }

    private setupDiscordReceive(bridge: ActiveBridge) {
        const receiver = bridge.discordConnection.receiver;

        receiver.speaking.on('start', (userId) => {
            if (bridge.discordUserSubs.has(userId)) return;

            const stream = receiver.subscribe(userId, {
                end: { behavior: EndBehaviorType.Manual },
            });

            bridge.discordPassthroughUsers.add(userId);
            bridge.discordUserSubs.set(userId, stream);
            this.refreshDiscordPassthroughMode(bridge);
        });

        receiver.speaking.on('end', (userId) => {
            const stream = bridge.discordUserSubs.get(userId);
            if (stream) {
                stream.removeAllListeners('data');
                stream.unpipe();
                stream.destroy();
            }
            bridge.discordUserSubs.delete(userId);
            bridge.discordPassthroughUsers.delete(userId);
            bridge.discordMixer.remove(userId);
            this.refreshDiscordPassthroughMode(bridge);
        });
    }

    private handleFluxerAudioFrame(
        bridgeId: string,
        participantId: string,
        samples: Int16Array
    ) {
        const bridge = this.activeBridges.get(bridgeId);
        if (!bridge) return;
        if (participantId === this.fluxerClient?.user?.id) return;

        bridge.fluxerMixer.push(participantId, samples);
        this.forwardFluxerMixed(bridge);
    }

    /** Mix latest Discord PCM and forward immediately (multi-speaker path). */
    private forwardDiscordMixed(bridge: ActiveBridge) {
        const mixed = bridge.discordMixer.mix();
        if (!this.hasAudio(mixed)) return;

        try {
            const opus = this.encodeOpus(bridge, this.monoToStereo(mixed));
            bridge.discordToFluxerOpus.pushPacket(opus);
        } catch {
            // skip bad frame
        }
    }

    /** Mix latest Fluxer PCM and forward immediately. */
    private forwardFluxerMixed(bridge: ActiveBridge) {
        const mixed = bridge.fluxerMixer.mix();
        bridge.fluxerMixer.clear();
        if (!this.hasAudio(mixed)) return;

        try {
            const opus = this.encodeOpus(bridge, this.monoToStereo(mixed));
            bridge.fluxerToDiscordOpus.pushPacket(opus);
        } catch {
            // skip bad frame
        }
    }

    private encodeOpus(bridge: ActiveBridge, stereo: Buffer): Buffer {
        const enc = bridge.opusEncoder as unknown as {
            _encode(buffer: Buffer): Buffer;
        };
        return enc._encode(stereo);
    }

    private hasAudio(samples: Int16Array): boolean {
        for (let i = 0; i < samples.length; i++) {
            if (samples[i] !== 0) return true;
        }
        return false;
    }

    private stereoToMono(stereo: Buffer): Int16Array {
        const count = stereo.length / 4;
        const mono = new Int16Array(count);
        for (let i = 0; i < count; i++) {
            const left = stereo.readInt16LE(i * 4);
            const right = stereo.readInt16LE(i * 4 + 2);
            mono[i] = Math.trunc((left + right) / 2);
        }
        return mono;
    }

    private monoToStereo(mono: Int16Array): Buffer {
        const buf = Buffer.alloc(mono.length * 4);
        for (let i = 0; i < mono.length; i++) {
            buf.writeInt16LE(mono[i]!, i * 4);
            buf.writeInt16LE(mono[i]!, i * 4 + 2);
        }
        return buf;
    }

    private async stopBridge(bridgeId: string) {
        const bridge = this.activeBridges.get(bridgeId);
        if (!bridge) return;

        for (const sub of bridge.fluxerReceiveSubs) {
            sub.stop();
        }

        for (const stream of bridge.discordUserSubs.values()) {
            stream.destroy();
        }

        bridge.discordToFluxerOpus.stop();
        bridge.fluxerToDiscordOpus.stop();
        bridge.discordPlayer.stop(true);
        bridge.opusEncoder.destroy();

        if (bridge.fluxerConnection) {
            const voiceManager = getVoiceManager(this.fluxerClient!);
            voiceManager.leaveChannel(bridge.voiceLink.fluxerChannelId);
        }

        bridge.discordConnection.destroy();
        this.activeBridges.delete(bridgeId);

        logger.info(
            `Voice bridge stopped: Discord ${bridge.voiceLink.discordChannelId} ↔ Fluxer ${bridge.voiceLink.fluxerChannelId}`
        );
    }

    async stopAll() {
        for (const id of [...this.activeBridges.keys()]) {
            await this.stopBridge(id);
        }
    }
}
