<div align="center">
  <img src="https://img.shields.io/badge/Next.js-black?style=for-the-badge&logo=next.js&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/SQLite-07405E?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Docker-2CA5E0?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
</div>

<h1 align="center">Recomendarr — HampusAndersson01 fork</h1>

<p align="center">
  A self-hosted, AI-powered media recommendation engine that analyzes your watch history and recommends personalized movies and TV shows for <b>Radarr</b> and <b>Sonarr</b>. This fork adds optional <b>Ryot</b> watch-history support.
</p>

## ✨ Features

- **Automated Discovery**: Analyzes your watch history from **Plex**, **Jellyfin**, or **Emby**.
- **Dual Recommendation Engines**: Uses both **TMDb** for related content and **OpenAI** (or compatible LLMs) for deep, personalized AI recommendations.
- **Direct Integration**: Adds approved media straight into Radarr and Sonarr—no Jellyseerr or Overseerr required.
- **Guided Setup Wizard**: A discovery-first, 5-step onboarding UI with a final review screen to connect all your services in minutes.
- **UI-Driven Configuration**: No complex `.env` files to manage. Settings are editable from a beautiful web interface and persisted in a lightweight SQLite database.
- **Ryot History (Fork Feature)**: Optionally merge completed movie and show history from Ryot with Plex, Jellyfin, or Emby history. Jellyfin watched episodes are included as series history.

---

## � App Preview

<p align="center">
  <img src="docs/recomendarr_demo_v3_0_1.webp" alt="Recomendarr Demo" width="100%">
</p>

<details>
<summary><b>Click to view more screenshots</b></summary>

<br/>

**Dashboard Overview**
<img src="docs/dashboard.png" alt="Dashboard" width="100%">

**Smart AI Recommendations**
<img src="docs/recommendations.png" alt="Recommendations" width="100%">

**Library Tracking**
<img src="docs/library.png" alt="Library" width="100%">

**Connection Testing & Settings**
<img src="docs/settings.png" alt="Settings" width="100%">

**Real-time System Logs**
<img src="docs/logs.png" alt="Logs" width="100%">

</details>

### 📺 Supported Media Servers

Recomendarr supports **Plex**, **Jellyfin**, and **Emby** out of the box. Choose your server during setup — the wizard dynamically adapts fields and instructions for each.

<table>
<tr>
<td align="center"><b>📺 Plex</b></td>
<td align="center"><b>🟣 Jellyfin</b></td>
<td align="center"><b>🟢 Emby</b></td>
</tr>
<tr>
<td><img src="docs/setup-plex.png" alt="Plex Setup" width="300"></td>
<td><img src="docs/setup-jellyfin.png" alt="Jellyfin Setup" width="300"></td>
<td><img src="docs/setup-emby.png" alt="Emby Setup" width="300"></td>
</tr>
</table>

---

## �🚀 Getting Started

Recomendarr is designed to be ridiculously easy to spin up, primarily via Docker. All configuration and API keys are handled entirely through the Web UI during the initial Setup Wizard.

### Option 1: Docker Compose (Recommended)

1. Create a `docker-compose.yml` file:
```yaml
services:
  recomendarr:
    image: ghcr.io/hampusandersson01/recomendarr:sha-1db44ea
    container_name: recomendarr
    ports:
      - "3000:3000"
    volumes:
      - recomendarr-data:/app/data
    restart: unless-stopped

volumes:
  recomendarr-data:
```

2. Start the container:
```bash
docker-compose up -d
```

### Option 2: Docker CLI (`docker run`)

If you prefer to run the container directly without Compose:
```bash
docker run -d \
  --name recomendarr \
  -p 3000:3000 \
  -v recomendarr-data:/app/data \
  --restart unless-stopped \
  ghcr.io/hampusandersson01/recomendarr:sha-1db44ea
```

### Option 3: Local Node.js Development
If you want to run from source or contribute to development:

1. Clone the repository:
```bash
git clone https://github.com/HampusAndersson01/recomendarr.git
cd recomendarr
```
2. Install dependencies:
```bash
npm install
```
3. Start the development server:
```bash
npm run dev
```

---

## ⚙️ Initial Setup Wizard

No matter which deployment method you choose, open your browser and navigate to:
**[http://localhost:3000](http://localhost:3000)**

On your first visit, you will be greeted by the **Setup Wizard**, which will walk you through setting up your ecosystem in 5 easy steps:

1. **Media Server**: Connect Plex, Jellyfin, or Emby to allow Recomendarr to read your Watch History.
2. **Sonarr**: Connect your Sonarr instance for handling TV Series.
3. **Radarr**: Connect your Radarr instance for handling Movies.
4. **AI Recommender (Optional)**: Provide an OpenAI API key (or compatible local LLM URL) for context-aware, hyper-personalized recommendations.
5. **Review**: Confirm the discovered defaults and save the full stack before the first run.

Once setup is complete, settings are permanently saved to the `recomendarr.db` SQLite database inside your Docker volume. 

*If you ever need to change API keys or URLs later, simply click on the **Settings** tab in the app.*

## Ryot history integration (fork-specific)

This fork can optionally add completed movie and show history from [Ryot](https://github.com/IgnisDa/ryot) to the configured Plex, Jellyfin, or Emby history. It is useful for older viewing data imported into Ryot, including Netflix history that is not in your media server. Jellyfin remains supported and Ryot can be left disabled for existing setups.

In **Settings → Media Server**, enable Ryot, set its internal Docker URL (for example `http://ryot:8000` when both containers share a Docker network), and add a Ryot API token. In Ryot, create the token under **Settings → Integrations**; Recomendarr sends it as a Bearer token to Ryot's `/backend/graphql` endpoint. The token is stored server-side and is not returned by Recomendarr's settings API. Ensure Recomendarr can reach the Ryot URL from its container.

Use **Test connection** to check endpoint reachability and run the authenticated history query. The result reports whether the history query succeeded and how many watched items it returned. If Ryot is unreachable or its history query fails, Recomendarr logs a sanitized warning and continues with media-server history. Engine logs report each source count, the merged count, and candidate count without logging API tokens or request headers. When both sources contain the same title, Recomendarr deduplicates by TMDb ID, then IMDb/TVDb ID, then normalized title, year, and media type. It keeps the latest completion date, Ryot rating when available, and the larger source-reported play count rather than adding the counts together.

The latest history fix is available as `ghcr.io/hampusandersson01/recomendarr:sha-1db44ea`. Pull it with `docker pull ghcr.io/hampusandersson01/recomendarr:sha-1db44ea`. The `sha-<commit>` tags are immutable; check the [fork's package page](https://github.com/HampusAndersson01/recomendarr/pkgs/container/recomendarr) for newer builds. This fork's Ryot integration and engine fixes may differ from upstream Recomendarr.

---

## 🏗 Built With
- [Next.js](https://nextjs.org/) (App Router & Server Actions)
- [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3) (Zero-config embedded DB)
- [Docker](https://www.docker.com/) (Standalone Next.js output)

## 🤝 Contribution
This is a personal fork of [upstream Recomendarr](https://github.com/dheerajramasahayam/recomendarr). Fork-specific issues and feature requests belong on the [HampusAndersson01 fork](https://github.com/HampusAndersson01/recomendarr/issues).
