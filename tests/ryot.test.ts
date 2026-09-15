import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizePublicSettings } from '../src/lib/config';
import { combineOptionalRyotHistory, mergeWatchHistories, normalizeRyotItem, RyotConnector } from '../src/lib/ryot';
import type { WatchedItem } from '../src/lib/types';

describe('Ryot watch history normalization', () => {
    it('normalizes a completed Ryot movie and its rating', () => {
        const item = normalizeRyotItem({
            metadata: {
                id: 'met_movie', title: 'Past Lives', lot: 'Movie', source: 'Tmdb', identifier: '666277',
                publishYear: 2023, description: 'A drama', genres: [{ name: 'Drama' }],
                assets: { remoteImages: ['https://example.test/poster.jpg'] },
            },
            history: [{ state: 'Completed', finishedOn: '2024-01-03T12:00:00Z', numTimesUpdated: 2, reviewId: 'review-1' }],
            reviews: [{ id: 'review-1', rating: 90 }],
        });
        expect(item).toMatchObject({
            title: 'Past Lives', year: 2023, mediaType: 'movie', tmdbId: 666277,
            genres: ['Drama'], rating: 9, playCount: 1, historySource: 'ryot',
        });
        expect(item?.lastPlayedDate).toBe('2024-01-03T12:00:00Z');
    });

    it('normalizes a Ryot show as one series entry with the latest completion', () => {
        const item = normalizeRyotItem({
            metadata: {
                id: 'met_show', title: 'The Bear', lot: 'Show', source: 'Tvdb', identifier: '418542',
                publishYear: 2022, genres: [{ name: 'Comedy' }],
            },
            history: [
                { state: 'Completed', finishedOn: '2023-01-01T00:00:00Z' },
                { state: 'Completed', finishedOn: '2024-02-01T00:00:00Z' },
            ], reviews: [],
        });
        expect(item).toMatchObject({ title: 'The Bear', mediaType: 'series', tvdbId: 418542, playCount: 2 });
        expect(item?.lastPlayedDate).toBe('2024-02-01T00:00:00Z');
    });

    it('does not count episode-level show completions as show rewatches', () => {
        const item = normalizeRyotItem({
            metadata: { id: 'met_show', title: 'The Bear', lot: 'Show', source: 'Tmdb', identifier: '136315' },
            history: Array.from({ length: 10 }, (_, index) => ({
                state: 'Completed', finishedOn: `2024-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
                showExtraInformation: { season: 1, episode: index + 1 },
            })),
            reviews: [],
        });
        expect(item).toMatchObject({ mediaType: 'series', playCount: 1 });
    });

    it('ignores unfinished items and ratings not linked to the user’s seen history', () => {
        const item = normalizeRyotItem({
            metadata: { id: 'met_movie', title: 'Unseen', lot: 'Movie', source: 'Tmdb', identifier: '1' },
            history: [{ state: 'InProgress', progress: 45 }],
            reviews: [{ id: 'another-user-review', rating: 100 }],
        });
        expect(item).toBeNull();
    });
});

describe('watch history merging', () => {
    const jellyfin: WatchedItem = {
        title: 'Past Lives', year: 2023, mediaType: 'movie', tmdbId: 666277,
        lastPlayedDate: '2024-02-01T00:00:00Z', playCount: 1,
    };
    const ryot: WatchedItem = {
        ...jellyfin, tmdbId: 666277, lastPlayedDate: '2024-01-03T12:00:00Z',
        playCount: 1, rating: 9, historySource: 'ryot',
    };

    it('deduplicates a shared TMDb item, retains the Ryot rating and avoids doubling play count', () => {
        expect(mergeWatchHistories([jellyfin], [ryot])).toEqual([
            expect.objectContaining({ rating: 9, playCount: 1, lastPlayedDate: jellyfin.lastPlayedDate }),
        ]);
    });

    it('deduplicates by normalized title, year and media type when IDs are absent', () => {
        const result = mergeWatchHistories(
            [{ title: 'Past Lives', year: 2023, mediaType: 'movie', playCount: 1 }],
            [{ title: ' past   lives ', year: 2023, mediaType: 'movie', playCount: 1, historySource: 'ryot' }],
        );
        expect(result).toHaveLength(1);
        expect(result[0].playCount).toBe(1);
    });

    it('does not title-deduplicate records with conflicting stable IDs', () => {
        const result = mergeWatchHistories(
            [{ title: 'Past Lives', year: 2023, mediaType: 'movie', tmdbId: 1 }],
            [{ title: 'Past Lives', year: 2023, mediaType: 'movie', tmdbId: 2 }],
        );
        expect(result).toHaveLength(2);
    });

    it('keeps Ryot-only imported titles', () => {
        expect(mergeWatchHistories([], [ryot])).toContainEqual(ryot);
    });

    it('keeps existing history unchanged when Ryot is disabled', async () => {
        const fetchHistory = async () => { throw new Error('must not run'); };
        const warn = () => { throw new Error('must not warn'); };
        const result = await combineOptionalRyotHistory([jellyfin, jellyfin], { enabled: false, url: '', apiToken: '' }, fetchHistory, warn);
        expect(result).toEqual([jellyfin, jellyfin]);
    });

    it('falls back to media-server history when Ryot is unavailable', async () => {
        const warnings: string[] = [];
        const result = await combineOptionalRyotHistory(
            [jellyfin], { enabled: true, url: 'http://ryot:8000', apiToken: 'secret' },
            async () => { throw new Error('network error'); }, (message) => warnings.push(message),
        );
        expect(result).toEqual([jellyfin]);
        expect(warnings).toEqual(['Could not fetch Ryot history (network error); continuing with media server history']);
    });
});

describe('Ryot connection test', () => {
    afterEach(() => vi.restoreAllMocks());

    it('uses the supported GraphQL path and bearer token', async () => {
        vi.spyOn(axios, 'get').mockRejectedValue({ isAxiosError: true, response: { status: 405 } });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { data: { userMetadataList: { response: { items: [], details: {} } } } } });
        const connector = new RyotConnector({ enabled: true, url: 'http://ryot:8000/', apiToken: 'user-token' });
        await expect(connector.testConnection()).resolves.toMatchObject({
            networkSuccess: true, historySuccess: true, historyCount: 0,
        });
        expect(post).toHaveBeenCalledWith(
            'http://ryot:8000/backend/graphql',
            expect.objectContaining({ query: expect.stringContaining('userMetadataList') }),
            expect.objectContaining({ headers: { Authorization: 'Bearer user-token' }, timeout: 10000 }),
        );
    });

    it('returns failure without surfacing network error details', async () => {
        vi.spyOn(axios, 'get').mockRejectedValue({ isAxiosError: true, response: { status: 405 } });
        vi.spyOn(axios, 'post').mockRejectedValue(new Error('request failed: sensitive detail'));
        const connector = new RyotConnector({ enabled: true, url: 'http://ryot:8000', apiToken: 'user-token' });
        await expect(connector.testConnection()).resolves.toMatchObject({
            networkSuccess: true, historySuccess: false, historyCount: 0,
            error: expect.stringContaining('authenticated history query failed'),
        });
    });

    it('distinguishes an unreachable endpoint from authenticated history failure', async () => {
        vi.spyOn(axios, 'get').mockRejectedValue(new Error('network unavailable'));
        const post = vi.spyOn(axios, 'post');
        const connector = new RyotConnector({ enabled: true, url: 'http://ryot:8000', apiToken: 'user-token' });
        await expect(connector.testConnection()).resolves.toMatchObject({
            networkSuccess: false, historySuccess: false, historyCount: 0,
        });
        expect(post).not.toHaveBeenCalled();
    });
});

describe('Ryot credential handling', () => {
    it('never includes the Ryot token in public settings data', () => {
        const saved = { ryot_enabled: 'true', ryot_api_token: 'sensitive-token' };
        expect(sanitizePublicSettings(saved)).toEqual({ ryot_enabled: 'true' });
        expect(saved.ryot_api_token).toBe('sensitive-token');
    });
});
