import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaServerConnector } from '../src/lib/media-server';
import type { MediaServerConfig } from '../src/lib/types';

describe('Jellyfin watch history', () => {
    afterEach(() => vi.restoreAllMocks());

    it('includes watched episodes and normalizes them to one series item', async () => {
        const get = vi.fn()
            .mockResolvedValueOnce({
                data: {
                    Items: [
                        {
                            Id: 'episode-1', Type: 'Episode', Name: 'Pilot', SeriesId: 'series-1',
                            SeriesName: 'The Bear', UserData: { LastPlayedDate: '2024-03-01T00:00:00Z', PlayCount: 1 },
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    Items: [
                        {
                            Id: 'series-1', Type: 'Series', Name: 'The Bear', ProductionYear: 2022,
                            ProviderIds: { Tmdb: '136315', Tvdb: '418542' }, Genres: ['Comedy'],
                            Overview: 'A chef returns home.',
                        },
                    ],
                },
            });
        vi.spyOn(axios, 'create').mockReturnValue({ get } as unknown as ReturnType<typeof axios.create>);

        const connector = createMediaServerConnector({
            type: 'jellyfin', url: 'http://jellyfin:8096', apiKey: 'secret', userId: 'user-1', plexToken: '',
        } as MediaServerConfig);
        const history = await connector.getWatchHistory(50);

        expect(get).toHaveBeenNthCalledWith(1, '/Users/user-1/Items', expect.objectContaining({
            params: expect.objectContaining({ IncludeItemTypes: 'Movie,Episode', IsPlayed: true }),
        }));
        expect(history).toEqual([
            expect.objectContaining({
                title: 'The Bear', mediaType: 'series', tmdbId: 136315, tvdbId: 418542,
                playCount: 1, lastPlayedDate: '2024-03-01T00:00:00Z',
            }),
        ]);
    });
});
