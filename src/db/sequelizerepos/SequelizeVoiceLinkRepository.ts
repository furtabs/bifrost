import { nanoid } from 'nanoid';
import { VoiceLink } from '../entities/VoiceLink';
import { VoiceLinkModel } from '../models';
import { VoiceLinkRepository } from '../repositories/VoiceLinkRepository';

export class SequelizeVoiceLinkRepository implements VoiceLinkRepository {
    async create(data: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
    }): Promise<VoiceLink> {
        const model = await VoiceLinkModel.create({
            id: crypto.randomUUID(),
            linkId: nanoid(10),
            ...data,
        });

        if (!model) {
            throw new Error('Failed to create voice link');
        }

        return model.toJSON() as VoiceLink;
    }

    async findByGuildAndLinkId(
        guildLinkId: string,
        linkId: string
    ): Promise<VoiceLink | null> {
        const model = await VoiceLinkModel.findOne({
            where: { guildLinkId, linkId },
        });

        if (!model) return null;

        return model.toJSON() as VoiceLink;
    }

    async findAllByGuild(guildLinkId: string): Promise<VoiceLink[]> {
        const models = await VoiceLinkModel.findAll({
            where: { guildLinkId },
        });

        return models.map((m) => m.toJSON() as VoiceLink);
    }

    async findById(id: string): Promise<VoiceLink | null> {
        const model = await VoiceLinkModel.findOne({
            where: { id },
        });

        if (!model) return null;

        return model.toJSON() as VoiceLink;
    }

    async findByDiscordChannelId(
        discordChannelId: string
    ): Promise<VoiceLink | null> {
        const model = await VoiceLinkModel.findOne({
            where: { discordChannelId },
        });

        if (!model) return null;

        return model.toJSON() as VoiceLink;
    }

    async findByFluxerChannelId(
        fluxerChannelId: string
    ): Promise<VoiceLink | null> {
        const model = await VoiceLinkModel.findOne({
            where: { fluxerChannelId },
        });

        if (!model) return null;

        return model.toJSON() as VoiceLink;
    }

    async findAll(): Promise<VoiceLink[]> {
        const models = await VoiceLinkModel.findAll();
        return models.map((m) => m.toJSON() as VoiceLink);
    }

    async deleteById(id: string): Promise<void> {
        await VoiceLinkModel.destroy({
            where: { id },
        });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await VoiceLinkModel.destroy({
            where: { guildLinkId },
        });
    }

    async getVoiceLinksCount(): Promise<number> {
        return await VoiceLinkModel.count();
    }
}
