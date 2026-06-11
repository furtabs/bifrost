import {
    ChannelType,
    Client,
    EmbedBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import VoiceBridgeService from '../../../services/voiceBridge/VoiceBridgeService';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

type PendingVoiceLink = {
    fluxerChannelId: string;
    channelName: string;
    guildLinkId: string;
    discordChannelId: string;
};

export default class VoicelinkDiscordCommandHandler extends DiscordCommandHandler {
    private pending = new Map<
        string,
        { action: PendingVoiceLink; timer: NodeJS.Timeout }
    >();

    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly fluxerEntityResolver: FluxerEntityResolver,
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

    private resolveDiscordVoiceChannelId(
        message: DiscordCommandHandlerMessage,
        explicitId?: string
    ): string | null {
        if (explicitId) return explicitId;

        const member = message.member;
        if (member?.voice.channelId) {
            return member.voice.channelId;
        }

        return null;
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
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
                                `No pending voice link. Run \`${COMMAND_PREFIX}voicelink <fluxer-voice-channel-id>\` first.`
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
                    PermissionFlagsBits.Connect |
                        PermissionFlagsBits.Speak,
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
                                `Linked voice channel <#${pending.discordChannelId}> ↔ **#${pending.channelName}** successfully.\n` +
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

        const fluxerChannelId = args[0];
        const discordVoiceChannelId = args[1];

        if (!fluxerChannelId) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Usage: \`${COMMAND_PREFIX}voicelink <fluxer-voice-channel-id> [discord-voice-channel-id]\`\n` +
                                `> Links a Discord voice channel to a Fluxer voice channel for realtime audio bridging.\n` +
                                `> If you're in a Discord voice channel, that channel is used automatically.\n` +
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
            .getGuildLinkForDiscordGuild(message.guildId!)
            .catch(() => null);
        if (!guildLink) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This server is not linked to a Fluxer guild. Use \`${COMMAND_PREFIX}link <fluxer-guild-id>\` first.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const discordChannelId = this.resolveDiscordVoiceChannelId(
            message,
            discordVoiceChannelId
        );
        if (!discordChannelId) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Join a Discord voice channel first, or provide its ID as a second argument.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const discordChannel = await message.guild!.channels
            .fetch(discordChannelId)
            .catch(() => null);
        if (
            !discordChannel ||
            discordChannel.type !== ChannelType.GuildVoice
        ) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Channel \`${discordChannelId}\` is not a Discord voice channel.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const fluxerChannel = await this.fluxerEntityResolver
            .fetchChannel(guildLink.fluxerGuildId, fluxerChannelId)
            .catch(() => null);
        if (!fluxerChannel) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Could not find Fluxer channel \`${fluxerChannelId}\` in the linked guild.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const fluxerType = (fluxerChannel as { type?: number }).type;
        if (fluxerType !== 2 && fluxerType !== 13) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Fluxer channel \`${fluxerChannelId}\` does not appear to be a voice channel.`
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
                PermissionFlagsBits.Connect |
                    PermissionFlagsBits.Speak,
                'Connect & Speak'
            ))
        )
            return;

        const channelName =
            (fluxerChannel as { name?: string }).name ?? fluxerChannelId;

        this.setPending(message.author.id, {
            fluxerChannelId,
            channelName,
            guildLinkId: guildLink.id,
            discordChannelId,
        });

        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(
                        `Found Fluxer voice channel **#${channelName}**.\n` +
                            `Run \`${COMMAND_PREFIX}voicelink confirm\` to link <#${discordChannelId}> to it for realtime audio bridging.`
                    )
                    .setColor(EmbedColors.Warning)
                    .setFooter(footer)
                    .setTimestamp(),
            ],
        });
    }
}
