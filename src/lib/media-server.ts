import axios, { AxiosInstance } from 'axios';
import { getConfig } from './config';
import type { WatchedItem, MediaServerConfig } from './types';
import { addLog } from './database';

// ============================================
// Unified Media Server Connector
// ============================================

export interface MediaServerConnector {
    testConnection(): Promise<boolean>;
    getWatchHistory(limit?: number): Promise<WatchedItem[]>;
    getUsers(): Promise<{ id: string; name: string }[]>;
}

// ============================================
// Jellyfin Connector
// ============================================
class JellyfinConnector implements MediaServerConnector {
    private client: AxiosInstance;
    private cfg: MediaServerConfig;

    constructor(cfg: MediaServerConfig) {
        this.cfg = cfg;
        this.client = axios.create({
            baseURL: cfg.url,
            headers: {
                'X-Emby-Token': cfg.apiKey,
                'Content-Type': 'application/json',
            },
        });
    }

    async testConnection(): Promise<boolean> {
        try {
            const res = await this.client.get('/System/Info');
            addLog({ level: 'INFO', message: `Connected to Jellyfin: ${res.data.ServerName}`, source: 'jellyfin' });
            return true;
        } catch (err) {
            addLog({ level: 'ERROR', message: `Failed to connect to Jellyfin: ${(err as Error).message}`, source: 'jellyfin' });
            return false;
        }
    }

    async getUsers(): Promise<{ id: string; name: string }[]> {
        const res = await this.client.get('/Users');
        return res.data.map((u: { Id: string; Name: string }) => ({ id: u.Id, name: u.Name }));
    }

    async getWatchHistory(limit = 50): Promise<WatchedItem[]> {
        const userId = this.cfg.userId;
        const res = await this.client.get(`/Users/${userId}/Items`, {
            params: {
                SortBy: 'DatePlayed',
                SortOrder: 'Descending',
                IsPlayed: true,
                Fields: 'ProviderIds,Genres,Overview,UserData',
                IncludeItemTypes: 'Movie,Episode',
                Limit: limit,
                Recursive: true,
            },
        });

        const rawItems = res.data.Items as Array<Record<string, unknown>>;
        const movies = rawItems.filter((item) => item.Type === 'Movie');
        const episodes = rawItems.filter((item) => item.Type === 'Episode');
        const seriesIds = [...new Set(episodes.map((item) => item.SeriesId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
        let seriesById = new Map<string, Record<string, unknown>>();

        if (seriesIds.length > 0) {
            try {
                const seriesResponse = await this.client.get(`/Users/${userId}/Items`, {
                    params: {
                        Ids: seriesIds.join(','),
                        IncludeItemTypes: 'Series',
                        Fields: 'ProviderIds,Genres,Overview,ImageTags',
                        Recursive: true,
                    },
                });
                seriesById = new Map(
                    (seriesResponse.data.Items as Array<Record<string, unknown>>)
                        .map((series) => [series.Id as string, series]),
                );
            } catch (err) {
                addLog({ level: 'WARN', message: `Could not load Jellyfin series metadata for watched episodes: ${(err as Error).name}`, source: 'jellyfin' });
            }
        }

        const movieItems: WatchedItem[] = movies.map((item) => {
            const providerIds = (item.ProviderIds || {}) as Record<string, string>;
            const userData = (item.UserData || {}) as Record<string, unknown>;
            return {
                title: item.Name as string,
                year: item.ProductionYear as number | undefined,
                mediaType: item.Type === 'Movie' ? 'movie' : 'series',
                tmdbId: providerIds.Tmdb ? parseInt(providerIds.Tmdb) : undefined,
                tvdbId: providerIds.Tvdb ? parseInt(providerIds.Tvdb) : undefined,
                imdbId: providerIds.Imdb || undefined,
                genres: (item.Genres || []) as string[],
                lastPlayedDate: userData.LastPlayedDate as string | undefined,
                playCount: userData.PlayCount as number | undefined,
                overview: item.Overview as string | undefined,
                posterUrl: item.ImageTags && (item.ImageTags as Record<string, string>).Primary
                    ? `${this.cfg.url}/Items/${item.Id}/Images/Primary`
                    : undefined,
            };
        });

        const showHistory = new Map<string, WatchedItem>();
        for (const episode of episodes) {
            const seriesId = typeof episode.SeriesId === 'string' ? episode.SeriesId : '';
            const series = seriesId ? seriesById.get(seriesId) : undefined;
            const title = typeof series?.Name === 'string'
                ? series.Name
                : typeof episode.SeriesName === 'string' ? episode.SeriesName : '';
            if (!title) continue;

            const providerIds = (series?.ProviderIds || {}) as Record<string, string>;
            const userData = (episode.UserData || {}) as Record<string, unknown>;
            const key = seriesId || `${title.toLowerCase()}:${series?.ProductionYear || ''}`;
            const existing = showHistory.get(key);
            const playedDate = userData.LastPlayedDate as string | undefined;
            const existingDate = existing?.lastPlayedDate;
            if (existing && existingDate && playedDate && Date.parse(existingDate) >= Date.parse(playedDate)) continue;

            showHistory.set(key, {
                title,
                year: series?.ProductionYear as number | undefined,
                mediaType: 'series',
                tmdbId: providerIds.Tmdb ? parseInt(providerIds.Tmdb, 10) : undefined,
                tvdbId: providerIds.Tvdb ? parseInt(providerIds.Tvdb, 10) : undefined,
                imdbId: providerIds.Imdb || undefined,
                genres: (series?.Genres || []) as string[],
                lastPlayedDate: playedDate,
                // Episode events establish show interest; they are not show rewatches.
                playCount: 1,
                overview: series?.Overview as string | undefined,
                posterUrl: series?.ImageTags && (series.ImageTags as Record<string, string>).Primary
                    ? `${this.cfg.url}/Items/${series?.Id}/Images/Primary`
                    : undefined,
            });
        }

        const items = [...movieItems, ...showHistory.values()]
            .sort((a, b) => Date.parse(b.lastPlayedDate || '') - Date.parse(a.lastPlayedDate || ''))
            .slice(0, limit);

        addLog({ level: 'INFO', message: `Fetched ${items.length} watched items from Jellyfin`, source: 'jellyfin' });
        return items;
    }
}

// ============================================
// Plex Connector
// ============================================
class PlexConnector implements MediaServerConnector {
    private client: AxiosInstance;
    private cfg: MediaServerConfig;

    constructor(cfg: MediaServerConfig) {
        this.cfg = cfg;
        this.client = axios.create({
            baseURL: cfg.url,
            headers: {
                'X-Plex-Token': cfg.plexToken || cfg.apiKey,
                Accept: 'application/json',
            },
        });
    }

    async testConnection(): Promise<boolean> {
        try {
            const res = await this.client.get('/');
            const serverName = res.data?.MediaContainer?.friendlyName || 'Plex Server';
            addLog({ level: 'INFO', message: `Connected to Plex: ${serverName}`, source: 'plex' });
            return true;
        } catch (err) {
            addLog({ level: 'ERROR', message: `Failed to connect to Plex: ${(err as Error).message}`, source: 'plex' });
            return false;
        }
    }

    async getUsers(): Promise<{ id: string; name: string }[]> {
        // Plex primary user
        try {
            const res = await this.client.get('/accounts');
            const accounts = res.data?.MediaContainer?.Account || [];
            return accounts.map((a: { id: number; name: string }) => ({
                id: String(a.id),
                name: a.name,
            }));
        } catch {
            return [{ id: '1', name: 'Primary User' }];
        }
    }

    async getWatchHistory(limit = 50): Promise<WatchedItem[]> {
        // Get all library sections first
        const sectionsRes = await this.client.get('/library/sections');
        const sections = sectionsRes.data?.MediaContainer?.Directory || [];
        const items: WatchedItem[] = [];

        for (const section of sections) {
            if (section.type !== 'movie' && section.type !== 'show') continue;
            try {
                const res = await this.client.get(`/library/sections/${section.key}/recentlyViewed`, {
                    params: { 'X-Plex-Container-Size': limit },
                });
                const media = res.data?.MediaContainer?.Metadata || [];
                for (const item of media) {
                    items.push({
                        title: item.title,
                        year: item.year,
                        mediaType: section.type === 'movie' ? 'movie' : 'series',
                        genres: item.Genre?.map((g: { tag: string }) => g.tag) || [],
                        lastPlayedDate: item.lastViewedAt ? new Date(item.lastViewedAt * 1000).toISOString() : undefined,
                        overview: item.summary,
                        posterUrl: item.thumb ? `${this.cfg.url}${item.thumb}?X-Plex-Token=${this.cfg.plexToken || this.cfg.apiKey}` : undefined,
                    });
                }
            } catch (err) {
                addLog({ level: 'WARN', message: `Error fetching Plex section ${section.title}: ${(err as Error).message}`, source: 'plex' });
            }
        }

        addLog({ level: 'INFO', message: `Fetched ${items.length} watched items from Plex`, source: 'plex' });
        return items.slice(0, limit);
    }
}

// ============================================
// Emby Connector
// ============================================
class EmbyConnector implements MediaServerConnector {
    private client: AxiosInstance;
    private cfg: MediaServerConfig;

    constructor(cfg: MediaServerConfig) {
        this.cfg = cfg;
        this.client = axios.create({
            baseURL: cfg.url,
            headers: {
                'X-Emby-Token': cfg.apiKey,
                'Content-Type': 'application/json',
            },
        });
    }

    async testConnection(): Promise<boolean> {
        try {
            const res = await this.client.get('/System/Info');
            addLog({ level: 'INFO', message: `Connected to Emby: ${res.data.ServerName}`, source: 'emby' });
            return true;
        } catch (err) {
            addLog({ level: 'ERROR', message: `Failed to connect to Emby: ${(err as Error).message}`, source: 'emby' });
            return false;
        }
    }

    async getUsers(): Promise<{ id: string; name: string }[]> {
        const res = await this.client.get('/Users');
        return res.data.map((u: { Id: string; Name: string }) => ({ id: u.Id, name: u.Name }));
    }

    async getWatchHistory(limit = 50): Promise<WatchedItem[]> {
        const userId = this.cfg.userId;
        const res = await this.client.get(`/Users/${userId}/Items`, {
            params: {
                SortBy: 'DatePlayed',
                SortOrder: 'Descending',
                IsPlayed: true,
                Fields: 'ProviderIds,Genres,Overview,UserData',
                IncludeItemTypes: 'Movie,Series',
                Limit: limit,
                Recursive: true,
            },
        });

        const items: WatchedItem[] = res.data.Items.map((item: Record<string, unknown>) => {
            const providerIds = (item.ProviderIds || {}) as Record<string, string>;
            const userData = (item.UserData || {}) as Record<string, unknown>;
            return {
                title: item.Name as string,
                year: item.ProductionYear as number | undefined,
                mediaType: item.Type === 'Movie' ? 'movie' : 'series',
                tmdbId: providerIds.Tmdb ? parseInt(providerIds.Tmdb) : undefined,
                tvdbId: providerIds.Tvdb ? parseInt(providerIds.Tvdb) : undefined,
                imdbId: providerIds.Imdb || undefined,
                genres: (item.Genres || []) as string[],
                lastPlayedDate: userData.LastPlayedDate as string | undefined,
                playCount: userData.PlayCount as number | undefined,
                overview: item.Overview as string | undefined,
                posterUrl: item.ImageTags && (item.ImageTags as Record<string, string>).Primary
                    ? `${this.cfg.url}/Items/${item.Id}/Images/Primary`
                    : undefined,
            };
        });

        addLog({ level: 'INFO', message: `Fetched ${items.length} watched items from Emby`, source: 'emby' });
        return items;
    }
}

// ============================================
// Factory
// ============================================
export function createMediaServerConnector(cfg?: MediaServerConfig): MediaServerConnector {
    const c = cfg || getConfig().mediaServer;
    switch (c.type) {
        case 'jellyfin':
            return new JellyfinConnector(c);
        case 'plex':
            return new PlexConnector(c);
        case 'emby':
            return new EmbyConnector(c);
        default:
            throw new Error(`Unsupported media server type: ${c.type}`);
    }
}
