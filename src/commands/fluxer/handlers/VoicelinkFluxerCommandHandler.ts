import {
    Client,
    EmbedBuilder,
    Message,
    PermissionsBitField,
    VoiceChannel,
} from '@fluxerjs/core';
import { getVoiceManager } from '@fluxerjs/voice';
import { LinkService } from '../../../services/LinkService';
import VoiceBridgeService from '../../../services/voiceBridge/VoiceBridgeService';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

type PendingVoiceLink = {
    discordChannelId: string;
    channelName: string;
    guildLinkId: string;
    fluxerChannelId: string;
};

export default class VoicelinkFluxerCommandHandler extends FluxerCommandHandler {
    private pending = new Map<
        string,
        { action: PendingVoiceLink; timer: NodeJS.Timeout }
    >();

    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly discordEntityResolver: DiscordEntityResolver,
        private readonly voiceBridgeService: VoiceBridgeService
    ) {
        super(client);
    }

    private setPending(userId: string, action: PendingVoiceLink) {
        const existing = this.pending.get(userId);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(
            () => this.pending.delete(userId),
            5 * 60 * 1000
        );
        this.pending.set(userId, { action, timer });
    }

    private takePending(userId: string): PendingVoiceLink | null {
        const entry = this.pending.get(userId);
        if (!entry) return null;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        return entry.action;
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        if (args[0]?.toLowerCase() === 'confirm') {
            const pending = this.takePending(message.author.id);
            if (!pending) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `No pending voice link. Run \`${COMMAND_PREFIX}voicelink <discord-voice-channel-id>\` first.`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }

            if (
                !(await this.requirePermission(
                    message,
                    PermissionsBitField.Flags.Connect |
                        PermissionsBitField.Flags.Speak,
                    'Connect & Speak'
                ))
            )
                return;

            try {
                const voiceLink = await this.linkService.createVoiceLink({
                    guildLinkId: pending.guildLinkId,
                    discordChannelId: pending.discordChannelId,
                    fluxerChannelId: pending.fluxerChannelId,
                });
                await this.voiceBridgeService.onVoiceLinkCreated(voiceLink);
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Linked this voice channel ↔ **#${pending.channelName}** on Discord successfully.\n` +
                                    `The bot will join and bridge audio when someone is in either channel.\n` +
                                    `-# Experimental realtime voice bridge — expect latency and quality issues.`
                            )
                            .setColor(EmbedColors.Success)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
            } catch (err: unknown) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Failed to link voice channel: ${(err as Error).message}`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                logger.error('Voicelink failed:', err);
            }
            return;
        }

        const discordChannelId = args[0];
        const fluxerVoiceChannelId = args[1];

        if (!discordChannelId) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Usage: \`${COMMAND_PREFIX}voicelink <discord-voice-channel-id> [fluxer-voice-channel-id]\`\n` +
                                `> Links a Fluxer voice channel to a Discord voice channel for realtime audio bridging.\n` +
                                `> If you're in a Fluxer voice channel, that channel is used automatically.\n` +
                                `> Then run \`${COMMAND_PREFIX}voicelink confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const guildLink = await this.linkService
            .getGuildLinkForFluxerGuild(message.guildId!)
            .catch(() => null);
        if (!guildLink) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This server is not linked to a Discord guild. Use \`${COMMAND_PREFIX}link <discord-guild-id>\` first.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const voiceManager = getVoiceManager(this.getClient());
        let fluxerChannelId =
            fluxerVoiceChannelId ??
            voiceManager.getVoiceChannelId(
                message.guildId!,
                message.author.id
            );

        if (!fluxerChannelId) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Join a Fluxer voice channel first, or provide its ID as a second argument.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const guild = await this.getClient().guilds.fetch(message.guildId!);
        if (!guild) return;
        const channels = await guild.fetchChannels();
        const fluxerChannel = channels.find((ch) => ch.id === fluxerChannelId);
        if (!(fluxerChannel instanceof VoiceChannel)) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Channel \`${fluxerChannelId}\` is not a Fluxer voice channel.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const discordChannel = await this.discordEntityResolver
            .fetchChannel(guildLink.discordGuildId, discordChannelId)
            .catch(() => null);
        if (!discordChannel) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Could not find Discord channel \`${discordChannelId}\` in the linked guild.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        if (
            !(await this.requirePermission(
                message,
                PermissionsBitField.Flags.Connect |
                    PermissionsBitField.Flags.Speak,
                'Connect & Speak'
            ))
        )
            return;

        const channelName =
            (discordChannel as { name?: string }).name ?? discordChannelId;

        this.setPending(message.author.id, {
            discordChannelId,
            channelName,
            guildLinkId: guildLink.id,
            fluxerChannelId,
        });

        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(
                        `Found Discord voice channel **#${channelName}**.\n` +
                            `Run \`${COMMAND_PREFIX}voicelink confirm\` to link this channel to it for realtime audio bridging.`
                    )
                    .setColor(EmbedColors.Warning)
                    .setFooter(footer)
                    .setTimestamp(),
            ],
        });
    }
}
