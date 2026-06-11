import { GuildLinkModel } from './GuildLinkModel';
import { ChannelLinkModel } from './ChannelLinkModel';
import { VoiceLinkModel } from './VoiceLinkModel';
import { MessageLinkModel } from './MessageLinkModel';
import { QueuedMessageModel } from './QueuedMessageModel';

// Guild -> Channel
GuildLinkModel.hasMany(ChannelLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'channelLinks',
    onDelete: 'CASCADE',
});

ChannelLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

// Guild -> Voice
GuildLinkModel.hasMany(VoiceLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'voiceLinks',
    onDelete: 'CASCADE',
});

VoiceLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

// Guild -> MessageLinks
GuildLinkModel.hasMany(MessageLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'messageLinks',
    onDelete: 'CASCADE',
});

MessageLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

// Channel -> MessageLinks
ChannelLinkModel.hasMany(MessageLinkModel, {
    foreignKey: 'channelLinkId',
    as: 'messageLinks',
    onDelete: 'CASCADE',
});

MessageLinkModel.belongsTo(ChannelLinkModel, {
    foreignKey: 'channelLinkId',
    as: 'channelLink',
});

export {
    GuildLinkModel,
    ChannelLinkModel,
    VoiceLinkModel,
    MessageLinkModel,
    QueuedMessageModel,
};
