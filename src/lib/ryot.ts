import axios from 'axios';
import { addLog } from './database';
import type { RyotConfig, WatchedItem } from './types';

type RyotMetadata = {
    id: string;
    title: string;
    lot: 'Movie' | 'Show' | string;
    source?: string;
    identifier?: string;
    publishYear?: number;
    description?: string;
    originalLanguage?: string;
    genres?: Array<{ name: string }>;
    externalIdentifiers?: { tvdbId?: number };
    assets?: { remoteImages?: string[] };
};

type RyotSeen = {
    state?: string;
    progress?: number;
    finishedOn?: string;
    lastUpdatedOn?: string;
    numTimesUpdated?: number;
    reviewId?: string;
    showExtraInformation?: { season: number; episode: number } | null;
};

type RyotReview = { id: string; rating?: number | string | null };

export function normalizeRyotItem(data: {
    metadata: RyotMetadata;
    history: RyotSeen[];
    reviews: RyotReview[];
}): WatchedItem | null {
    const { metadata } = data;
    if (metadata.lot !== 'Movie' && metadata.lot !== 'Show') return null;

    const completed = data.history.filter((seen) =>
        seen.state === 'Completed' || (typeof seen.progress === 'number' && seen.progress >= 100));
    if (completed.length === 0) return null;

    const lastSeen = completed
        .map((seen) => seen.finishedOn || seen.lastUpdatedOn)
        .filter((date): date is string => Boolean(date))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    const linkedReviewIds = new Set(completed.map((seen) => seen.reviewId).filter((id): id is string => Boolean(id)));
    const latestReview = [...data.reviews]
        .filter((review) => linkedReviewIds.has(review.id) && review.rating !== null && review.rating !== undefined && Number.isFinite(Number(review.rating)))
        .sort((a, b) => {
            const aSeenIndex = completed.findIndex((seen) => seen.reviewId === a.id);
            const bSeenIndex = completed.findIndex((seen) => seen.reviewId === b.id);
            return bSeenIndex - aSeenIndex;
        })[0];
    const numericRating = latestReview ? Number(latestReview.rating) : undefined;

    return {
        title: metadata.title,
        year: metadata.publishYear,
        mediaType: metadata.lot === 'Movie' ? 'movie' : 'series',
        tmdbId: metadata.source === 'Tmdb' ? positiveId(metadata.identifier) : undefined,
        tvdbId: metadata.source === 'Tvdb'
            ? positiveId(metadata.identifier)
            : positiveId(metadata.externalIdentifiers?.tvdbId),
        genres: metadata.genres?.map((genre) => genre.name) || [],
        lastPlayedDate: lastSeen,
        playCount: metadata.lot === 'Show' && completed.some((seen) => seen.showExtraInformation)
            ? 1
            : completed.length,
        // Ryot stores review ratings on a 0–100 scale regardless of display scale.
        rating: numericRating === undefined ? undefined : Math.max(0, Math.min(10, numericRating / 10)),
        language: metadata.originalLanguage,
        overview: metadata.description,
        posterUrl: metadata.assets?.remoteImages?.[0],
        historySource: 'ryot',
    };
}

function positiveId(value: unknown): number | undefined {
    const id = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function identityKeys(item: WatchedItem): string[] {
    const keys: string[] = [];
    if (item.tmdbId) keys.push(`${item.mediaType}:tmdb:${item.tmdbId}`);
    if (item.imdbId) keys.push(`${item.mediaType}:imdb:${item.imdbId.toLowerCase()}`);
    if (item.tvdbId) keys.push(`${item.mediaType}:tvdb:${item.tvdbId}`);
    return keys;
}

function titleYearKey(item: WatchedItem): string | undefined {
    if (!item.title.trim() || !item.year) return undefined;
    return `${item.mediaType}:title:${item.title.trim().toLocaleLowerCase().replace(/\s+/g, ' ')}:${item.year}`;
}

function identifiersConflict(a: WatchedItem, b: WatchedItem): boolean {
    return Boolean(
        (a.tmdbId && b.tmdbId && a.tmdbId !== b.tmdbId)
        || (a.imdbId && b.imdbId && a.imdbId.toLowerCase() !== b.imdbId.toLowerCase())
        || (a.tvdbId && b.tvdbId && a.tvdbId !== b.tvdbId),
    );
}

function mergeItems(items: WatchedItem[]): WatchedItem {
    const rank = (item: WatchedItem) => Number(Boolean(item.tmdbId)) * 4 + Number(Boolean(item.imdbId)) * 3 + Number(Boolean(item.tvdbId)) * 2 + Number(Boolean(item.genres?.length));
    const sorted = [...items].sort((a, b) => rank(b) - rank(a));
    const merged: WatchedItem = { ...sorted[0] };
    for (const item of sorted.slice(1)) {
        merged.tmdbId ||= item.tmdbId;
        merged.imdbId ||= item.imdbId;
        merged.tvdbId ||= item.tvdbId;
        merged.year ||= item.year;
        merged.language ||= item.language;
        merged.overview ||= item.overview;
        merged.posterUrl ||= item.posterUrl;
        if (!merged.lastPlayedDate || (item.lastPlayedDate && Date.parse(item.lastPlayedDate) > Date.parse(merged.lastPlayedDate))) {
            merged.lastPlayedDate = item.lastPlayedDate;
        }
        merged.playCount = Math.max(merged.playCount || 0, item.playCount || 0);
        merged.genres = [...new Set([...(merged.genres || []), ...(item.genres || [])])];
    }
    merged.rating = items.find((item) => item.historySource === 'ryot' && item.rating !== undefined)?.rating
        ?? items.find((item) => item.rating !== undefined)?.rating;
    if (items.some((item) => item.historySource === 'ryot')) merged.historySource = 'ryot';
    return merged;
}

export function mergeWatchHistories(...sources: WatchedItem[][]): WatchedItem[] {
    const result: WatchedItem[] = [];
    const keysToIndex = new Map<string, number>();
    for (const item of sources.flat()) {
        const keys = identityKeys(item);
        let matchingIndex = keys.map((key) => keysToIndex.get(key)).find((index) => index !== undefined);
        if (matchingIndex === undefined) {
            const fallbackKey = titleYearKey(item);
            matchingIndex = fallbackKey
                ? result.findIndex((existing) => titleYearKey(existing) === fallbackKey && !identifiersConflict(existing, item))
                : -1;
            if (matchingIndex === -1) matchingIndex = undefined;
        }
        if (matchingIndex === undefined) {
            const index = result.push(item) - 1;
            for (const key of keys) keysToIndex.set(key, index);
            const fallbackKey = titleYearKey(item);
            if (fallbackKey) keysToIndex.set(fallbackKey, index);
            continue;
        }
        result[matchingIndex] = mergeItems([result[matchingIndex], item]);
        for (const key of identityKeys(result[matchingIndex])) keysToIndex.set(key, matchingIndex);
        const fallbackKey = titleYearKey(result[matchingIndex]);
        if (fallbackKey) keysToIndex.set(fallbackKey, matchingIndex);
    }
    return result;
}

export async function combineOptionalRyotHistory(
    mediaServerHistory: WatchedItem[],
    config: RyotConfig,
    fetchHistory: (config: RyotConfig) => Promise<WatchedItem[]>,
    warn: (message: string) => void,
): Promise<WatchedItem[]> {
    if (!config.enabled) return mediaServerHistory;
    if (!config.apiToken) {
        warn('Ryot history is enabled but no API token is configured; continuing with media server history');
        return mediaServerHistory;
    }
    try {
        return mergeWatchHistories(mediaServerHistory, await fetchHistory(config));
    } catch (error) {
        warn(`Could not fetch Ryot history (${safeRyotError(error, config.apiToken)}); continuing with media server history`);
        return mediaServerHistory;
    }
}

function safeRyotError(error: unknown, token: string): string {
    if (axios.isAxiosError(error)) {
        if (error.response) return `HTTP ${error.response.status}`;
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'request timed out';
        return 'network request failed';
    }

    if (!(error instanceof Error)) return 'unknown error';
    let message = error.message;
    if (token) message = message.replaceAll(token, '[redacted]');
    message = message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
    message = message.replace(/https?:\/\/[^\s"']+/gi, '[Ryot endpoint]');
    return message.slice(0, 200) || 'unknown error';
}

export interface RyotConnectionTestResult {
    networkSuccess: boolean;
    historySuccess: boolean;
    historyCount: number;
    error?: string;
}

export class RyotConnector {
    private readonly baseUrl: string;
    private readonly token: string;
    private failedHistoryDetails = 0;

    constructor(config: RyotConfig) {
        this.baseUrl = `${config.url.replace(/\/+$/, '')}/backend/graphql`;
        this.token = config.apiToken;
    }

    private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
        const response = await axios.post<{ data?: T; errors?: Array<{ message?: string }> }>(
            this.baseUrl,
            { query, variables },
            { headers: { Authorization: `Bearer ${this.token}` }, timeout: 10000 },
        );
        if (response.data.errors?.length) {
            const firstMessage = response.data.errors.find((error) => error.message)?.message;
            throw new Error(firstMessage ? `Ryot GraphQL error: ${firstMessage}` : 'Ryot returned a GraphQL error');
        }
        if (!response.data.data) throw new Error('Ryot returned an invalid GraphQL response');
        return response.data.data;
    }

    async testConnection(limit = 50): Promise<RyotConnectionTestResult> {
        let networkSuccess = false;
        try {
            await axios.get(this.baseUrl, { timeout: 10000 });
            networkSuccess = true;
        } catch (error) {
            // GraphQL commonly rejects a bare GET with 4xx, which still proves
            // the endpoint is reachable. Network errors have no HTTP response.
            networkSuccess = axios.isAxiosError(error) && Boolean(error.response);
            if (!networkSuccess) {
                return { networkSuccess: false, historySuccess: false, historyCount: 0, error: 'Ryot endpoint is unreachable' };
            }
        }

        try {
            const history = await this.getWatchHistory(limit);
            const historySuccess = this.failedHistoryDetails === 0;
            return {
                networkSuccess,
                historySuccess,
                historyCount: history.length,
                ...(historySuccess ? {} : { error: 'One or more Ryot history details could not be loaded' }),
            };
        } catch (error) {
            return {
                networkSuccess,
                historySuccess: false,
                historyCount: 0,
                error: `Ryot authenticated history query failed (${safeRyotError(error, this.token)})`,
            };
        }
    }

    async getWatchHistory(limit = 50): Promise<WatchedItem[]> {
        const items: WatchedItem[] = [];
        this.failedHistoryDetails = 0;
        const loadBatch = async (ids: string[]) => {
            const batch = await Promise.allSettled(ids.map(async (metadataId) => {
                const data = await this.query<{
                    metadataDetails: { response: RyotMetadata };
                    userMetadataDetails: { response: { history: RyotSeen[]; reviews: RyotReview[] } };
                }>(
                    'query RyotHistoryDetails($metadataId: String!) { metadataDetails(metadataId: $metadataId) { response { id title lot source identifier publishYear description originalLanguage genres { name } externalIdentifiers { tvdbId } assets { remoteImages } } } userMetadataDetails(metadataId: $metadataId) { response { history { state progress finishedOn lastUpdatedOn numTimesUpdated reviewId showExtraInformation { season episode } } reviews { id rating } } } }',
                    { metadataId },
                );
                return normalizeRyotItem({
                    metadata: data.metadataDetails.response,
                    history: data.userMetadataDetails.response.history,
                    reviews: data.userMetadataDetails.response.reviews,
                });
            }));
            for (const result of batch) {
                if (result.status === 'fulfilled') {
                    if (result.value) items.push(result.value);
                } else {
                    this.failedHistoryDetails++;
                }
            }
        };

        for (const lot of ['Movie', 'Show']) {
            const lotStartCount = items.length;
            for (let pageNumber = 1; pageNumber <= 100; pageNumber++) {
                const page = await this.query<{ userMetadataList: { response: { items: string[]; details: { nextPage?: number } } } }>(
                    'query RyotUserMetadataList($input: UserMetadataListInput!) { userMetadataList(input: $input) { response { items details { nextPage } } } }',
                    { input: { lot, search: { take: 100, page: pageNumber } } },
                );
                const response = page.userMetadataList.response;
                for (let offset = 0; offset < response.items.length; offset += 5) {
                    await loadBatch(response.items.slice(offset, offset + 5));
                    if (items.length - lotStartCount >= limit) break;
                }
                if (items.length - lotStartCount >= limit || !response.details.nextPage) break;
            }
        }
        const history = items
            .sort((a, b) => Date.parse(b.lastPlayedDate || '') - Date.parse(a.lastPlayedDate || ''))
            .slice(0, limit);
        addLog({ level: 'INFO', message: `[ryot] fetched ${history.length} watched items`, source: 'ryot' });
        addLog({
            level: 'INFO',
            message: `[ryot] test item Moana present: ${history.some((item) => item.title.trim().toLocaleLowerCase() === 'moana')}`,
            source: 'ryot',
        });
        if (this.failedHistoryDetails > 0) {
            addLog({
                level: 'WARN',
                message: `[ryot] ${this.failedHistoryDetails} metadata history detail request(s) failed; retained successful results`,
                source: 'ryot',
            });
        }
        return history;
    }
}

export async function getRyotWatchHistory(config: RyotConfig, limit: number): Promise<WatchedItem[]> {
    return new RyotConnector(config).getWatchHistory(limit);
}
