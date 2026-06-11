import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';

export class VoiceLinkModel extends Model {}

VoiceLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },

        guildLinkId: {
            type: DataTypes.UUID,
        },

        discordChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        fluxerChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        linkId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'voice_links',
        createdAt: 'createdAt',
        updatedAt: false,
    }
);
