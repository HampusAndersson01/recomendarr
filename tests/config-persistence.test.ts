import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('configuration persistence', () => {
    const originalDatabasePath = process.env.DATABASE_PATH;
    let tempDirectory: string | undefined;

    afterEach(() => {
        if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = originalDatabasePath;
        vi.resetModules();
        if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
        tempDirectory = undefined;
    });

    it('reloads persisted Jellyfin and Ryot settings after clearing the config cache', async () => {
        tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recomendarr-config-'));
        process.env.DATABASE_PATH = path.join(tempDirectory, 'settings.db');
        vi.resetModules();
        const config = await import('../src/lib/config');

        config.saveSettings({
            media_server_type: 'jellyfin',
            media_server_url: 'http://jellyfin:8096',
            media_server_api_key: 'jellyfin-secret',
            media_server_user_id: 'jellyfin-user-id',
            ryot_enabled: 'true',
            ryot_url: 'http://ryot:8000',
            ryot_api_token: 'ryot-secret',
        });
        config.clearSettingsCache();

        expect(config.getConfig()).toMatchObject({
            mediaServer: {
                type: 'jellyfin', url: 'http://jellyfin:8096',
                apiKey: 'jellyfin-secret', userId: 'jellyfin-user-id',
            },
            ryot: { enabled: true, url: 'http://ryot:8000', apiToken: 'ryot-secret' },
        });
    });
});
